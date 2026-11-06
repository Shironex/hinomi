import type { ScanLogger } from '../scan/index.js'

export interface DeliverOptions {
  fetch: typeof fetch
  /** Waits; replaced in tests. */
  sleep: (ms: number) => Promise<void>
  log: ScanLogger
  /** Tries in total, the first one included. Default 5. */
  maxAttempts?: number
  /** First backoff step. Doubles each retry. Default 1000 ms. */
  baseDelayMs?: number
  /** Longest wait the backoff alone reaches. Default 30 s. */
  maxBackoffMs?: number
  /** A `retry_after` longer than this gives up instead of waiting. Default 2 minutes. */
  maxRetryAfterMs?: number
  timeoutMs?: number
}

/** Delivery failed for good. The message never contains the webhook URL. */
export class DeliveryError extends Error {
  override readonly name = 'DeliveryError'
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Seconds from Discord's JSON body (`retry_after`, may be fractional) or the Retry-After header, in ms. */
async function retryAfterMs(response: Response): Promise<number | null> {
  try {
    const body: unknown = await response.clone().json()
    if (body && typeof body === 'object' && 'retry_after' in body) {
      const value = Number(body.retry_after)
      if (Number.isFinite(value) && value >= 0) return Math.ceil(value * 1000)
    }
  } catch {
    // Not JSON: fall through to the header.
  }
  const header = Number(response.headers.get('retry-after'))
  return Number.isFinite(header) && header > 0 ? Math.ceil(header * 1000) : null
}

function scrub(message: string, url: string): string {
  return message.split(url).join('[webhook url]')
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'fatal'; error: DeliveryError }
  | { kind: 'retry'; error: DeliveryError; askedMs: number }

async function attemptOnce(
  url: string,
  payload: string,
  options: DeliverOptions,
): Promise<Outcome> {
  let response: Response
  try {
    response = await options.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'hinomi' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const failure = new DeliveryError(`Could not reach the webhook: ${scrub(text, url)}`, null)
    return { kind: 'retry', error: failure, askedMs: 0 }
  }
  if (response.ok) return { kind: 'sent' }
  if (response.status === 429) {
    const asked = (await retryAfterMs(response)) ?? 0
    if (asked > (options.maxRetryAfterMs ?? 120_000)) {
      const error = new DeliveryError(
        `Rate limited for ${Math.round(asked / 1000)} s, giving up`,
        429,
      )
      return { kind: 'fatal', error }
    }
    return {
      kind: 'retry',
      error: new DeliveryError('Rate limited (HTTP 429)', 429),
      askedMs: asked,
    }
  }
  const error = new DeliveryError(`The webhook answered HTTP ${response.status}`, response.status)
  return response.status >= 500 ? { kind: 'retry', error, askedMs: 0 } : { kind: 'fatal', error }
}

/**
 * POSTs a JSON body to a webhook. Retries on HTTP 429, 5xx and network
 * errors. After a 429 it waits for Discord's `retry_after` but never less
 * than the exponential backoff of that attempt (base, 2x, 4x, ...), so a
 * server that answers `retry_after: 0` is not hammered. Other 4xx answers fail
 * at once: retrying a bad URL or payload cannot help.
 */
export async function deliver(url: string, body: unknown, options: DeliverOptions): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 5
  const base = options.baseDelayMs ?? 1000
  const maxBackoff = options.maxBackoffMs ?? 30_000
  const payload = JSON.stringify(body)

  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptOnce(url, payload, options)
    if (outcome.kind === 'sent') return
    if (outcome.kind === 'fatal' || attempt >= maxAttempts) throw outcome.error

    const backoff = Math.min(base * 2 ** (attempt - 1), maxBackoff)
    const wait = Math.max(backoff, outcome.askedMs)
    options.log.warn('notification delivery failed, retrying', {
      status: outcome.error.status,
      attempt,
      waitMs: wait,
    })
    await options.sleep(wait)
  }
}
