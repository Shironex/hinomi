import { currentTime, type CoolifyErrorCode } from '@hinomi/shared'

export class CoolifyError extends Error {
  readonly code: CoolifyErrorCode
  readonly status?: number
  /** Seconds Coolify asked to wait (429 with a Retry-After header), when it said. */
  readonly retryAfterSeconds?: number

  constructor(
    code: CoolifyErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CoolifyError'
    this.code = code
    this.status = options?.status
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}

/** Retry-After as seconds: a number of seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: Date = currentTime()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000))
}

export function errorForStatus(
  status: number,
  path: string,
  retryAfter: string | null = null,
): CoolifyError {
  const where = `Coolify answered ${status} for ${path}`
  if (status === 401)
    return new CoolifyError('unauthorized', `${where}: the token was rejected`, { status })
  if (status === 403) {
    return new CoolifyError(
      'forbidden',
      `${where}: the token lacks permission (a read token is enough)`,
      { status },
    )
  }
  if (status === 404)
    return new CoolifyError('not_found', `${where}: endpoint not found`, { status })
  if (status === 429) {
    // Coolify counts failed requests per token or IP (30 a minute) and answers 429 after that.
    const seconds = parseRetryAfter(retryAfter)
    const wait = seconds === null ? '' : `, retry after ${seconds} s`
    return new CoolifyError('rate_limited', `${where}: too many failed requests${wait}`, {
      status,
      ...(seconds !== null && { retryAfterSeconds: seconds }),
    })
  }
  if (status >= 500) return new CoolifyError('server_error', `${where}: server error`, { status })
  return new CoolifyError('http_error', where, { status })
}
