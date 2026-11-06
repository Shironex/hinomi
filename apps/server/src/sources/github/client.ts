import { GithubError, GithubRateLimitError } from './errors.js'

const DEFAULT_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'hinomi'

export interface GithubClientOptions {
  token: string
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
}

export interface GithubClient {
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

  async function send(path: string, init: RequestInit): Promise<RestResult> {
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
    for (let attempt = 0; ; attempt++) {
      await waitForBlock()
      const final = attempt >= maxRetries

      let result: RestResult
      try {
        result = await send(path, init)
      } catch (error) {
        if (
          error instanceof GithubError &&
          (error.kind === 'network' || error.kind === 'timeout')
        ) {
          if (final) throw error
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
        if (final) {
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
    rest(path, { acceptStatus = [] } = {}) {
      return execute(path, { method: 'GET' }, acceptStatus)
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
