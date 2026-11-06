import type { CoolifyErrorCode } from '@hinomi/shared'

export class CoolifyError extends Error {
  readonly code: CoolifyErrorCode
  readonly status?: number

  constructor(
    code: CoolifyErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CoolifyError'
    this.code = code
    this.status = options?.status
  }
}

export function errorForStatus(status: number, path: string): CoolifyError {
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
  if (status >= 500) return new CoolifyError('server_error', `${where}: server error`, { status })
  return new CoolifyError('http_error', where, { status })
}
