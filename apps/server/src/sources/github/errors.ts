export type GithubErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'http'
  | 'graphql'
  | 'network'
  | 'timeout'
  | 'parse'

export class GithubError extends Error {
  readonly kind: GithubErrorKind
  readonly status: number | null

  constructor(
    kind: GithubErrorKind,
    message: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GithubError'
    this.kind = kind
    this.status = options.status ?? null
  }
}

/** The rate limit is exhausted and the wait is longer than the client is allowed to sleep. */
export class GithubRateLimitError extends GithubError {
  /** Epoch milliseconds before which a request would be refused again. */
  readonly retryAt: number

  constructor(message: string, retryAt: number, status: number | null = null) {
    super('rate_limit', message, { status })
    this.name = 'GithubRateLimitError'
    this.retryAt = retryAt
  }
}

export function isGithubError(error: unknown, kind?: GithubErrorKind): error is GithubError {
  return error instanceof GithubError && (kind === undefined || error.kind === kind)
}
