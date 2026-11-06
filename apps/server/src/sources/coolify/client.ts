import { CoolifyError, errorForStatus } from './errors.js'

export interface CoolifyClientOptions {
  baseUrl: string
  token: string
  /** Per request timeout. Defaults to 15 s. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
}

export interface CoolifyClient {
  /** GET a path below /api/v1 and return the parsed JSON body. */
  getJson(path: string): Promise<unknown>
  /** GET a path below /api/v1 and return the body as trimmed text. */
  getText(path: string): Promise<string>
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Accepts the instance URL with or without a trailing slash, `/api` or `/api/v1`. */
export function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch (cause) {
    throw new CoolifyError('invalid_config', 'The Coolify URL is not a valid URL', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CoolifyError('invalid_config', 'The Coolify URL must start with http:// or https://')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/i, '')
  return `${url.origin}${path}`
}

export function createCoolifyClient(options: CoolifyClientOptions): CoolifyClient {
  const base = normalizeBaseUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token) throw new CoolifyError('invalid_config', 'The Coolify token is empty')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function request(path: string, accept: string): Promise<string> {
    let res: Response
    try {
      res = await doFetch(`${base}/api/v1${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      ) {
        throw new CoolifyError('timeout', `Coolify did not answer ${path} within ${timeoutMs} ms`, {
          cause,
        })
      }
      throw new CoolifyError('network', `Could not reach Coolify for ${path}`, { cause })
    }
    if (!res.ok) throw errorForStatus(res.status, path)
    try {
      return (await res.text()).trim()
    } catch (cause) {
      throw new CoolifyError('network', `Connection dropped while reading ${path}`, { cause })
    }
  }

  return {
    async getJson(path) {
      const body = await request(path, 'application/json')
      try {
        return JSON.parse(body) as unknown
      } catch (cause) {
        throw new CoolifyError('invalid_response', `Coolify returned invalid JSON for ${path}`, {
          cause,
        })
      }
    },
    getText: (path) => request(path, 'text/plain, application/json'),
  }
}
