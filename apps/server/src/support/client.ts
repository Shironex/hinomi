import { nowMs } from '@hinomi/shared'

// The endoflife.date client: one conditional GET of `products/full`. The API answers 304 to a
// matching validator, 301 for a renamed product, 429 with `Retry-After` when asked too often, and
// an HTML page (not JSON) for a missing one. Nothing here throws: every outcome is a result.

export const EOL_API_BASE = 'https://endoflife.date/api/v1'
export const PRODUCTS_FULL_PATH = '/products/full'

const USER_AGENT = 'hinomi-support-data'
/** One request, body included (the answer is about 3 MB uncompressed). */
const DEFAULT_TIMEOUT_MS = 30_000
/** More than any real answer; a body past it is refused instead of read. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_ATTEMPTS = 3
const MAX_REDIRECTS = 3
const BACKOFF_BASE_MS = 2_000
/** A `Retry-After` longer than this is not waited for here: the daily job plans around it. */
const MAX_INLINE_WAIT_MS = 30_000

export interface Validators {
  etag: string | null
  lastModified: string | null
}

export type FetchResult =
  | { kind: 'updated'; body: string; etag: string | null; lastModified: string | null }
  | { kind: 'not_modified' }
  | {
      kind: 'failed'
      reason: string
      /** The API asked for this long a pause (429 or 503 with `Retry-After`). */
      retryAfterMs?: number
    }

export interface FetchProductsOptions {
  fetch?: typeof fetch
  /** What the cached copy was answered with. Sent back so an unchanged copy costs a 304. */
  validators?: Validators
  baseUrl?: string
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** `Retry-After` is seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = nowMs()): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** Reads a body up to MAX_BODY_BYTES; null when it is larger. The request's own timeout covers it. */
async function readLimited(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!res.body) return ''
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'the request timed out'
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetches `products/full` with the stored validators. A redirect is followed (up to 3 hops, and
 * only within the API's own host); 429 and 5xx are retried with backoff, honouring a short
 * `Retry-After` and reporting a long one to the caller.
 */
export async function fetchProductsFull(options: FetchProductsOptions = {}): Promise<FetchResult> {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const base = new URL(options.baseUrl ?? EOL_API_BASE)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  if (options.validators?.etag) headers['if-none-match'] = options.validators.etag
  else if (options.validators?.lastModified) {
    headers['if-modified-since'] = options.validators.lastModified
  }

  let url = new URL(`${base.href.replace(/\/$/, '')}${PRODUCTS_FULL_PATH}`)
  let redirects = 0
  let attempt = 0
  try {
    for (;;) {
      // The timeout covers one request with its body, not the pauses between retries.
      const signal = AbortSignal.timeout(timeoutMs)
      const res = await doFetch(url, { headers, signal, redirect: 'manual' })
      if (res.status === 304) return { kind: 'not_modified' }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        if (!location || redirects >= MAX_REDIRECTS) {
          return { kind: 'failed', reason: `too many redirects (last status ${res.status})` }
        }
        const next = new URL(location, url)
        if (next.origin !== base.origin) {
          return { kind: 'failed', reason: 'redirected to another host, not followed' }
        }
        url = next
        redirects++
        continue
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
        await res.body?.cancel().catch(() => undefined)
        attempt++
        const wait = retryAfter ?? BACKOFF_BASE_MS * 2 ** (attempt - 1)
        if (attempt >= MAX_ATTEMPTS || wait > MAX_INLINE_WAIT_MS) {
          return {
            kind: 'failed',
            reason: `endoflife.date answered ${res.status}`,
            ...(retryAfter !== null && { retryAfterMs: retryAfter }),
          }
        }
        await sleep(wait)
        continue
      }

      if (!res.ok) {
        // A 404 body is an HTML page, so nothing here is read as JSON.
        await res.body?.cancel().catch(() => undefined)
        return { kind: 'failed', reason: `endoflife.date answered ${res.status}` }
      }

      const body = await readLimited(res)
      if (body === null) return { kind: 'failed', reason: 'the answer is larger than expected' }
      return {
        kind: 'updated',
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
      }
    }
  } catch (error) {
    return { kind: 'failed', reason: describe(error) }
  }
}
