export const DOKPLOY_ERROR_CODES = [
  'invalid_config',
  'unauthorized',
  'forbidden',
  'not_found',
  'server_error',
  'http_error',
  'timeout',
  'network',
  'invalid_response',
] as const
export type DokployErrorCode = (typeof DOKPLOY_ERROR_CODES)[number]

/** A Dokploy read that failed. The message never holds the API key or a response body. */
export class DokployError extends Error {
  readonly code: DokployErrorCode
  readonly status?: number

  constructor(
    code: DokployErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DokployError'
    this.code = code
    this.status = options?.status
  }
}

export function errorForStatus(status: number, route: string): DokployError {
  const where = `Dokploy answered ${status} for ${route}`
  if (status === 401) {
    return new DokployError('unauthorized', `${where}: the API key was rejected`, { status })
  }
  if (status === 403) {
    return new DokployError('forbidden', `${where}: the API key's user lacks access`, { status })
  }
  if (status === 404) return new DokployError('not_found', `${where}: not found`, { status })
  if (status >= 500) return new DokployError('server_error', `${where}: server error`, { status })
  return new DokployError('http_error', where, { status })
}
