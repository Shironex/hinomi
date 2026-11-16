import { signTimestamped } from '../crypto/timestamped-signature.js'
import type { ScanLogger } from '../scan/index.js'
import { privateTargetProblem } from './channels.js'

/** The signature header of a generic webhook with a signing secret. Same scheme as the webhook runner. */
export const NOTIFY_SIGNATURE_HEADER = 'x-hinomi-signature'

export interface DeliverOptions {
  /** Used when the channel may post to private addresses (and by tests for every channel). */
  fetch: typeof fetch
  /** Used for every other channel: connects to public addresses only. */
  publicFetch: typeof fetch
  /** The clock of the signature timestamp. */
  now: () => Date
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

/** Where one request goes. Internal: the URL, headers and secrets are never logged. */
export interface DeliveryTarget {
  url: string
  /** Extra headers, for example a token. */
  headers?: Record<string, string>
  /** Signs the body with this secret in the X-Hinomi-Signature header (generic webhook). */
  signingSecret?: string | null
  /** Posts to private and loopback addresses only when true. */
  allowPrivate: boolean
  /** Removed from every error message, besides the URL itself (tokens). */
  secrets?: readonly (string | null)[]
}

/** The `retry_after` seconds of a JSON body: Discord's top level one or Telegram's `parameters`. */
function bodyRetryAfter(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const nested =
    'parameters' in body && body.parameters && typeof body.parameters === 'object'
      ? body.parameters
      : null
  const raw =
    'retry_after' in body
      ? body.retry_after
      : nested && 'retry_after' in nested
        ? nested.retry_after
        : undefined
  const value = Number(raw)
  return raw !== undefined && Number.isFinite(value) && value >= 0 ? value : null
}

/** Seconds from the JSON body (`retry_after`, may be fractional) or the Retry-After header, in ms. */
async function retryAfterMs(response: Response): Promise<number | null> {
  try {
    const value = bodyRetryAfter(await response.clone().json())
    if (value !== null) return Math.ceil(value * 1000)
  } catch {
    // Not JSON: fall through to the header.
  }
  const header = Number(response.headers.get('retry-after'))
  return Number.isFinite(header) && header > 0 ? Math.ceil(header * 1000) : null
}

function scrub(message: string, target: DeliveryTarget): string {
  let out = message.split(target.url).join('[webhook url]')
  for (const secret of target.secrets ?? []) {
    if (secret) out = out.split(secret).join('[secret]')
  }
  return out
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'fatal'; error: DeliveryError }
  | { kind: 'retry'; error: DeliveryError; askedMs: number }

async function attemptOnce(
  target: DeliveryTarget,
  payload: string | Uint8Array,
  options: DeliverOptions,
): Promise<Outcome> {
  let response: Response
  const send = target.allowPrivate ? options.fetch : options.publicFetch
  try {
    response = await send(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'hinomi',
        ...target.headers,
        ...(target.signingSecret && {
          [NOTIFY_SIGNATURE_HEADER]: signTimestamped(target.signingSecret, payload, options.now()),
        }),
      },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const failure = new DeliveryError(`Could not reach the webhook: ${scrub(text, target)}`, null)
    // A refused address stays refused: trying again cannot help.
    const refused = error instanceof Error && 'code' in error && error.code === 'ENOTPUBLIC'
    return refused
      ? { kind: 'fatal', error: failure }
      : { kind: 'retry', error: failure, askedMs: 0 }
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
  const error = new DeliveryError(
    response.status >= 300 && response.status < 400
      ? `The webhook answered with a redirect (HTTP ${response.status}); redirects are not followed`
      : `The webhook answered HTTP ${response.status}`,
    response.status,
  )
  return response.status >= 500 ? { kind: 'retry', error, askedMs: 0 } : { kind: 'fatal', error }
}

/**
 * POSTs a JSON body to a webhook. Retries on HTTP 429, 5xx and network
 * errors. After a 429 it waits for the `retry_after` of Discord or Telegram (or
 * the Retry-After header) but never less than the exponential backoff of that
 * attempt (base, 2x, 4x, ...), so a server that answers `retry_after: 0` is not
 * hammered. Other 4xx answers fail at once: retrying a bad URL or payload
 * cannot help. A literal private address or localhost is refused before
 * anything is sent unless the target allows private addresses; a host name
 * resolving to one is refused at connection time by `publicFetch`.
 */
export async function deliver(
  target: DeliveryTarget,
  /** JSON, or the raw bytes of an encrypted web push message. */
  body: unknown,
  options: DeliverOptions,
): Promise<void> {
  const refused = privateTargetProblem(target.url, target.allowPrivate)
  if (refused) throw new DeliveryError(refused, null)
  const maxAttempts = options.maxAttempts ?? 5
  const base = options.baseDelayMs ?? 1000
  const maxBackoff = options.maxBackoffMs ?? 30_000
  // Bytes (an encrypted web push message) go as they are, anything else as JSON.
  const payload = body instanceof Uint8Array ? body : JSON.stringify(body)

  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptOnce(target, payload, options)
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
