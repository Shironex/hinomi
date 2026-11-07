import {
  osvQueryBatchResponseSchema,
  osvVulnerabilitySchema,
  type OsvQuery,
  type OsvVulnerability,
  nowMs,
} from '@hinomi/shared'

export const OSV_API_URL = 'https://api.osv.dev'
/** OSV accepts at most 1000 queries per querybatch request. */
export const OSV_BATCH_LIMIT = 1000

export interface OsvClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  /** Per request timeout. */
  timeoutMs?: number
  /** Parallel `GET /v1/vulns/{id}` requests. */
  concurrency?: number
  /** Retries after the first attempt, for network errors, timeouts, 429 and 5xx. */
  maxRetries?: number
  /** First backoff delay; it doubles per retry. */
  baseDelayMs?: number
  maxDelayMs?: number
  batchSize?: number
  /** How long fetched vulnerability details stay cached. */
  cacheTtlMs?: number
  cacheMaxEntries?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface OsvClient {
  /** Vulnerability ids per query, in input order, following OSV pagination. */
  queryBatch(queries: OsvQuery[]): Promise<string[][]>
  getVulnerability(id: string): Promise<OsvVulnerability>
  /** Details for many ids with the concurrency limit; order follows `ids`. */
  getVulnerabilities(ids: string[]): Promise<OsvVulnerability[]>
}

export class OsvRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'OsvRequestError'
  }
}

const MAX_RETRY_AFTER_MS = 5 * 60 * 1000

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs `fn` over `items` with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after')
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? 0 : Math.max(0, date - nowMs())
}

export function createOsvClient(options: OsvClientOptions = {}): OsvClient {
  const baseUrl = (options.baseUrl ?? OSV_API_URL).replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const concurrency = options.concurrency ?? 4
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const batchSize = Math.min(options.batchSize ?? OSV_BATCH_LIMIT, OSV_BATCH_LIMIT)
  const cacheTtlMs = options.cacheTtlMs ?? 60 * 60 * 1000
  const cacheMaxEntries = options.cacheMaxEntries ?? 5000
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const cache = new Map<string, { expires: number; value: Promise<OsvVulnerability> }>()

  async function request(path: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let retryable: boolean
      let error: OsvRequestError
      let minDelay = 0
      try {
        const res = await doFetch(`${baseUrl}${path}`, {
          ...init,
          headers: { accept: 'application/json', ...init.headers },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.ok) return await res.json()
        retryable = res.status === 429 || res.status >= 500
        // Honour Retry-After, but never let one header stall a scan for long.
        minDelay = Math.min(retryAfterMs(res), MAX_RETRY_AFTER_MS)
        error = new OsvRequestError(`OSV ${path} answered ${res.status}`, res.status)
      } catch (err) {
        retryable = true
        error = new OsvRequestError(
          `OSV ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
          null,
        )
      }
      if (!retryable || attempt >= maxRetries) throw error
      // Exponential backoff with jitter added on top, never below the base curve.
      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)
      await sleep(Math.max(backoff + random() * backoff * 0.5, minDelay))
    }
  }

  async function postBatch(queries: OsvQuery[]) {
    const body = await request('/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries }),
    })
    const parsed = osvQueryBatchResponseSchema.parse(body)
    if (parsed.results.length !== queries.length) {
      throw new OsvRequestError('OSV querybatch returned a different number of results', null)
    }
    return parsed.results
  }

  async function queryBatch(queries: OsvQuery[]): Promise<string[][]> {
    const ids = queries.map(() => [] as string[])
    let pending = queries.map((query, index) => ({ index, query }))
    while (pending.length > 0) {
      const nextRound: typeof pending = []
      for (let start = 0; start < pending.length; start += batchSize) {
        const chunk = pending.slice(start, start + batchSize)
        const results = await postBatch(chunk.map((c) => c.query))
        results.forEach((result, i) => {
          const item = chunk[i]!
          for (const v of result.vulns ?? []) ids[item.index]!.push(v.id)
          if (result.next_page_token) {
            nextRound.push({
              index: item.index,
              query: { ...item.query, page_token: result.next_page_token },
            })
          }
        })
      }
      pending = nextRound
    }
    return ids.map((list) => [...new Set(list)])
  }

  function getVulnerability(id: string): Promise<OsvVulnerability> {
    const hit = cache.get(id)
    if (hit && hit.expires > now()) return hit.value
    const value = request(`/v1/vulns/${encodeURIComponent(id)}`, { method: 'GET' }).then((body) =>
      osvVulnerabilitySchema.parse(body),
    )
    cache.delete(id)
    cache.set(id, { expires: now() + cacheTtlMs, value })
    // Failed lookups are not cached.
    value.catch(() => {
      if (cache.get(id)?.value === value) cache.delete(id)
    })
    // Drop the oldest entries (Map keeps insertion order).
    while (cache.size > cacheMaxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return value
  }

  return {
    queryBatch,
    getVulnerability,
    getVulnerabilities: (ids) => mapLimit(ids, concurrency, getVulnerability),
  }
}
