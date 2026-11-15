import { DokployError, errorForStatus } from './errors.js'
import { parseStripped } from './strip.js'

// A read only client for the Dokploy API: GET on its tRPC style routes below /api, signed in
// with the `x-api-key` header. Every body is parsed through `parseStripped`, so no caller ever
// sees a secret looking key.

export interface DokployClientOptions {
  baseUrl: string
  /** The Dokploy API key. Full access: Hinomi only ever sends GET requests with it. */
  token: string
  /** Per request timeout. Defaults to 15 s. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
}

export interface DokployClient {
  /** GET a route (for example `application.one`) with query parameters, secrets stripped. */
  get(route: string, params?: Record<string, string>): Promise<unknown>
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Accepts the instance URL with or without a trailing slash, `/api` or `/swagger`. */
export function normalizeDokployUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch (cause) {
    throw new DokployError('invalid_config', 'The Dokploy URL is not a valid URL', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DokployError('invalid_config', 'The Dokploy URL must start with http:// or https://')
  }
  if (url.username || url.password) {
    throw new DokployError('invalid_config', 'The Dokploy URL must not hold a user or password')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(api|swagger)$/i, '')
  return `${url.origin}${path}`
}

export function createDokployClient(options: DokployClientOptions): DokployClient {
  const base = normalizeDokployUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token) throw new DokployError('invalid_config', 'The Dokploy API key is empty')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async get(route, params) {
      const query = params ? `?${new URLSearchParams(params).toString()}` : ''
      let res: Response
      try {
        res = await doFetch(`${base}/api/${route}${query}`, {
          method: 'GET',
          headers: { 'x-api-key': token, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        })
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === 'TimeoutError' || cause.name === 'AbortError')
        ) {
          throw new DokployError(
            'timeout',
            `Dokploy did not answer ${route} within ${timeoutMs} ms`,
            { cause: cause },
          )
        }
        throw new DokployError('network', `Could not reach Dokploy for ${route}`, { cause: cause })
      }
      if (!res.ok) {
        // The body is dropped unread: an error page may echo the request.
        await res.body?.cancel().catch(() => undefined)
        throw errorForStatus(res.status, route)
      }
      let body: string
      try {
        body = await res.text()
      } catch {
        throw new DokployError('network', `Connection dropped while reading ${route}`)
      }
      try {
        return parseStripped(body)
      } catch {
        throw new DokployError('invalid_response', `Dokploy returned invalid JSON for ${route}`)
      }
    },
  }
}
