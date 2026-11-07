import { GithubError, GithubRateLimitError } from './errors.js'

export const DEFAULT_BASE_URL = 'https://api.github.com'
export const API_VERSION = '2022-11-28'
export const USER_AGENT = 'hinomi'

/** Hands out the bearer token per request, for credentials that expire (a GitHub App). */
export interface GithubTokenProvider {
  getToken(): Promise<string>
  /** GitHub answered 401 to this token: drop it so the next `getToken` mints a fresh one. */
  invalidate(token: string): void
}

export interface GithubClientOptions {
  /** A fixed token (personal access token). Give this or `auth`. */
  token?: string
  /** Tokens that are minted and refreshed (GitHub App). A 401 refreshes once and retries. */
  auth?: GithubTokenProvider
  /** Override for GitHub Enterprise or tests. */
  baseUrl?: string
  fetch?: typeof fetch
  /** Per request timeout. */
  timeoutMs?: number
  /** Retries after a rate limit or a transient failure, per request. */
  maxRetries?: number
  /** Longest single wait. A longer rate limit window throws `GithubRateLimitError` instead. */
  maxWaitMs?: number
  /** Base of the exponential backoff for 5xx and network errors. */
  backoffBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface RestResult {
  status: number
  headers: Headers
  /** Parsed JSON, or null for an empty body. */
  data: unknown
}

export interface RestOptions {
  /** Non-2xx statuses returned to the caller instead of thrown. Rate limits are never accepted. */
  acceptStatus?: readonly number[]
  /** Defaults to GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Sent as JSON. */
  body?: unknown
  /**
   * Sent as If-None-Match, for conditional reads. Put 304 in `acceptStatus` to get the
   * not-modified answer back (it carries no data); GitHub does not count it against the limit.
   */
  ifNoneMatch?: string
  /**
   * `manual` hands back a redirect (put its status in `acceptStatus`) with its Location header
   * instead of following it, for downloads that redirect to blob storage.
   */
  redirect?: 'manual'
}

export interface GithubClient {
  /** The API root requests go to, without a trailing slash. */
  readonly baseUrl: string
  rest(path: string, options?: RestOptions): Promise<RestResult>
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function messageOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const { message } = data
    if (typeof message === 'string') return message
  }
  return ''
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const {
    token,
    auth,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = fetch,
    timeoutMs = 15_000,
    maxRetries = 3,
    maxWaitMs = 120_000,
    backoffBaseMs = 500,
    sleep = defaultSleep,
    now = Date.now,
  } = options

  // Epoch ms before which nothing is sent: set from retry-after or an exhausted rate limit and
  // shared by every request on this client, so parallel callers never retry faster than the backoff.
  let blockedUntil = 0

  if (token === undefined && auth === undefined) {
    throw new Error('createGithubClient needs a token or an auth provider')
  }
  const bearer = (): Promise<string> => (auth ? auth.getToken() : Promise.resolve(token ?? ''))

  async function waitForBlock(): Promise<void> {
    const wait = blockedUntil - now()
    if (wait > 0) await sleep(wait)
  }

  function block(untilMs: number): void {
    if (untilMs > blockedUntil) blockedUntil = untilMs
  }

  /** Milliseconds to wait when the response says the request was rate limited, else null. */
  function rateLimitWait(status: number, headers: Headers, data: unknown): number | null {
    const retryAfter = headerNumber(headers, 'retry-after')
    const remaining = headerNumber(headers, 'x-ratelimit-remaining')
    const reset = headerNumber(headers, 'x-ratelimit-reset')
    const limited =
      status === 429 ||
      (status === 403 &&
        (retryAfter !== null || remaining === 0 || /rate limit/i.test(messageOf(data))))
    if (!limited) return null
    if (retryAfter !== null) return Math.max(0, retryAfter * 1000)
    if (reset !== null) return Math.max(0, reset * 1000 - now()) + 1000
    // Secondary limits without headers: GitHub asks for at least a minute.
    return 60_000
  }

  async function send(path: string, init: RequestInit, token: string): Promise<RestResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GithubError('timeout', `GitHub request timed out after ${timeoutMs} ms`, {
          cause: error,
        })
      }
      throw new GithubError('network', 'GitHub request failed', { cause: error })
    }

    try {
      const text = await response.text()
      let data: unknown = null
      if (text !== '') {
        try {
          data = JSON.parse(text)
        } catch {
          if (response.ok) {
            throw new GithubError('parse', 'GitHub returned a body that is not JSON', {
              status: response.status,
            })
          }
          data = { message: text.slice(0, 200) }
        }
      }
      return { status: response.status, headers: response.headers, data }
    } catch (error) {
      if (error instanceof GithubError) throw error
      if (controller.signal.aborted) {
        throw new GithubError('timeout', `GitHub request timed out after ${timeoutMs} ms`, {
          cause: error,
        })
      }
      throw new GithubError('network', 'Reading the GitHub response failed', { cause: error })
    } finally {
      clearTimeout(timer)
    }
  }

  async function execute(
    path: string,
    init: RequestInit,
    acceptStatus: readonly number[],
  ): Promise<RestResult> {
    // A write that failed in transit or with a 5xx may still have happened on GitHub's side, so
    // only reads are retried then. Rate limits are always retried: GitHub did not act on those.
    const retryTransient = (init.method ?? 'GET') === 'GET' || path === '/graphql'
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      await waitForBlock()
      const final = attempt >= maxRetries

      let result: RestResult
      let used: string | undefined
      try {
        used = await bearer()
        result = await send(path, init, used)
      } catch (error) {
        if (
          error instanceof GithubError &&
          (error.kind === 'network' || error.kind === 'timeout')
        ) {
          if (final || !retryTransient) throw error
          const wait = backoffBaseMs * 2 ** attempt
          block(now() + wait)
          continue
        }
        throw error
      }

      const { status, headers, data } = result
      const waitMs = rateLimitWait(status, headers, data)
      if (waitMs !== null) {
        const retryAt = now() + waitMs
        if (waitMs > maxWaitMs || final) {
          throw new GithubRateLimitError(
            `GitHub rate limit reached, retry in ${Math.ceil(waitMs / 1000)} s`,
            retryAt,
            status,
          )
        }
        block(retryAt)
        continue
      }

      if (status >= 500) {
        if (final || !retryTransient) {
          throw new GithubError('http', `GitHub answered ${status}`, { status })
        }
        block(now() + backoffBaseMs * 2 ** attempt)
        continue
      }

      // Stay clear of the limit: when the budget is spent, hold the next request until reset.
      const remaining = headerNumber(headers, 'x-ratelimit-remaining')
      const reset = headerNumber(headers, 'x-ratelimit-reset')
      if (remaining === 0 && reset !== null) block(reset * 1000 + 1000)

      if (status >= 200 && status < 300) return result
      // An installation token can be revoked before it expires: mint a fresh one, once.
      if (status === 401 && auth && !refreshed) {
        refreshed = true
        if (used !== undefined) auth.invalidate(used)
        attempt--
        continue
      }
      if (acceptStatus.includes(status)) return result
      const detail = messageOf(data)
      const suffix = detail === '' ? '' : `: ${detail}`
      if (status === 401)
        throw new GithubError('auth', `GitHub rejected the token${suffix}`, { status })
      if (status === 403)
        throw new GithubError('permission', `GitHub denied access${suffix}`, { status })
      if (status === 404)
        throw new GithubError('not_found', `GitHub resource not found${suffix}`, { status })
      throw new GithubError('http', `GitHub answered ${status}${suffix}`, { status })
    }
  }

  return {
    baseUrl,
    rest(path, { acceptStatus = [], method = 'GET', body, ifNoneMatch, redirect } = {}) {
      const init: RequestInit = { method }
      if (body !== undefined) init.body = JSON.stringify(body)
      if (ifNoneMatch !== undefined) init.headers = { 'if-none-match': ifNoneMatch }
      if (redirect !== undefined) init.redirect = redirect
      return execute(path, init, acceptStatus)
    },

    async graphql(query, variables = {}) {
      for (let attempt = 0; ; attempt++) {
        const { data, headers } = await execute(
          '/graphql',
          { method: 'POST', body: JSON.stringify({ query, variables }) },
          [],
        )
        const body = (typeof data === 'object' && data !== null ? data : {}) as {
          data?: unknown
          errors?: { type?: string; message?: string }[]
        }
        const errors = body.errors ?? []
        if (errors.length === 0) return body.data

        const first = errors[0]
        const type = first?.type
        const message = first?.message ?? 'GraphQL error'
        if (type === 'RATE_LIMITED') {
          const reset = headerNumber(headers, 'x-ratelimit-reset')
          const waitMs = reset === null ? 60_000 : Math.max(0, reset * 1000 - now()) + 1000
          const retryAt = now() + waitMs
          if (waitMs > maxWaitMs || attempt >= maxRetries) {
            throw new GithubRateLimitError(message, retryAt)
          }
          block(retryAt)
          continue
        }
        if (type === 'NOT_FOUND') throw new GithubError('not_found', message)
        if (type === 'FORBIDDEN' || type === 'INSUFFICIENT_SCOPES') {
          throw new GithubError('permission', message)
        }
        throw new GithubError('graphql', message)
      }
    },
  }
}
