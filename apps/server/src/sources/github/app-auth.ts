import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { API_VERSION, DEFAULT_BASE_URL, USER_AGENT, type GithubTokenProvider } from './client.js'
import { GithubError, GithubRateLimitError } from './errors.js'
import { parsePayload } from './schemas.js'

/**
 * Signs in as a GitHub App installation: an RS256 JWT signed with the app's private key is
 * exchanged for an installation access token, which is cached until shortly before it expires.
 *
 * The private key, the JWT and the installation token never appear in an error message.
 */

export interface GithubAppCredentials {
  /** App ID or Client ID. GitHub accepts either as the JWT issuer. */
  appId: string
  installationId: string
  /** PEM, PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub hands out) or PKCS#8. */
  privateKey: string
}

export interface GithubAppAuthOptions extends GithubAppCredentials {
  /** Override for GitHub Enterprise or tests. */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

export interface GithubInstallation {
  /** Login of the user or organization the app is installed on. */
  account: string
  repositorySelection: 'all' | 'selected'
  /** Permission name to `read` or `write`, as granted to the installation. */
  permissions: Record<string, string>
}

export interface GithubAppAuth extends GithubTokenProvider {
  /** The installation as GitHub describes it, read with the app JWT. */
  installation(): Promise<GithubInstallation>
}

/** GitHub asks for `iat` 60 seconds in the past to absorb clock drift. */
const IAT_BACKDATE_S = 60
/** GitHub refuses an `exp` more than 10 minutes ahead; stay under it in case this clock runs fast. */
const JWT_LIFETIME_S = 9 * 60
/** Installation tokens live an hour. Mint a new one when less than this is left. */
const REFRESH_MARGIN_MS = 5 * 60_000

/** Permissions Hinomi needs on the installation, all read only. */
export const REQUIRED_APP_PERMISSIONS = ['dependabot_alerts', 'contents', 'metadata'] as const

const installationSchema = z.object({
  account: z
    .object({
      login: z.string().optional(),
      slug: z.string().optional(),
      name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  repository_selection: z.enum(['all', 'selected']),
  permissions: z.record(z.string(), z.string()).default({}),
})

const accessTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
})

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/** The issuer as GitHub shows it: a numeric App ID goes out as a number, a Client ID as text. */
function issuer(appId: string): string | number {
  return /^[0-9]+$/.test(appId) ? Number(appId) : appId
}

/** Reads the PEM once. A key that cannot be parsed is an auth error, without echoing the key. */
export function readAppPrivateKey(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch {
    throw new GithubError(
      'auth',
      'The GitHub App private key could not be read. Paste the whole .pem file GitHub generated.',
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GithubError('auth', 'The GitHub App private key must be an RSA key.')
  }
  return key
}

/** The app JWT: RS256 over `{ iat, exp, iss }`, `iat` backdated, at most ten minutes long. */
export function createAppJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ iat: now - IAT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: issuer(appId) }),
  )
  const input = `${header}.${payload}`
  // RSASSA-PKCS1-v1_5 with SHA-256 is what RS256 means, and node's default padding for RSA keys.
  const signature = sign('sha256', Buffer.from(input), key)
  return `${input}.${base64url(signature)}`
}

function messageOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const { message } = data
    if (typeof message === 'string') return message
  }
  return ''
}

export function createGithubAppAuth(options: GithubAppAuthOptions): GithubAppAuth {
  const {
    appId,
    installationId,
    privateKey,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = fetch,
    timeoutMs = 15_000,
    now = Date.now,
  } = options

  let key: KeyObject | null = null
  let cached: { token: string; expiresAt: number } | null = null
  let minting: Promise<string> | null = null

  async function appRequest(method: 'GET' | 'POST', path: string): Promise<unknown> {
    key ??= readAppPrivateKey(privateKey)
    const jwt = createAppJwt(appId, key, now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${jwt}`,
            'x-github-api-version': API_VERSION,
            'user-agent': USER_AGENT,
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
      const text = await response.text()
      let data: unknown = null
      try {
        data = text === '' ? null : JSON.parse(text)
      } catch {
        data = null
      }
      if (response.ok) return data

      const status = response.status
      const detail = messageOf(data)
      const suffix = detail === '' ? '' : ` (${detail})`
      if (status === 401) {
        throw new GithubError(
          'auth',
          `GitHub rejected the app credentials${suffix}. Check the App ID and the private key.`,
          { status },
        )
      }
      if (status === 404) {
        throw new GithubError(
          'not_found',
          `GitHub App installation ${installationId} was not found. Check the installation ID and that the app is installed.`,
          { status },
        )
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      if (status === 429 || (status === 403 && /rate limit/i.test(detail))) {
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000
        throw new GithubRateLimitError('GitHub rate limit reached', now() + waitMs, status)
      }
      if (status === 403) {
        throw new GithubError('permission', `GitHub denied the app access${suffix}`, { status })
      }
      throw new GithubError('http', `GitHub answered ${status}${suffix}`, { status })
    } finally {
      clearTimeout(timer)
    }
  }

  const installationPath = `/app/installations/${encodeURIComponent(installationId)}`

  async function mint(): Promise<string> {
    const data = await appRequest('POST', `${installationPath}/access_tokens`)
    const body = parsePayload(accessTokenSchema, data, 'installation access token')
    const expiresAt = Date.parse(body.expires_at)
    // An unreadable expiry falls back to the documented hour.
    cached = {
      token: body.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 60 * 60_000,
    }
    return body.token
  }

  return {
    async getToken() {
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token
      // Parallel callers share one exchange instead of minting a token each.
      minting ??= mint().finally(() => {
        minting = null
      })
      return minting
    },

    invalidate(token) {
      // Only the rejected token: a newer one minted meanwhile stays.
      if (cached?.token === token) cached = null
    },

    async installation() {
      const data = await appRequest('GET', installationPath)
      const body = parsePayload(installationSchema, data, 'installation')
      const account = body.account
      return {
        account: account?.login ?? account?.slug ?? account?.name ?? 'unknown account',
        repositorySelection: body.repository_selection,
        permissions: body.permissions,
      }
    },
  }
}

/** Required permissions the installation lacks. Write access counts as read. */
export function missingAppPermissions(permissions: Record<string, string>): string[] {
  return REQUIRED_APP_PERMISSIONS.filter((name) => {
    const level = permissions[name]
    return level !== 'read' && level !== 'write'
  })
}
