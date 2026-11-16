import type { ProvenIdentity } from './allowlist.js'
import { OidcError } from './oidc.js'

/**
 * Sign in with GitHub through an OAuth app. GitHub does not speak OpenID Connect for people, so
 * the code is traded for a short lived token that reads the account id, the login and the
 * primary verified email, and the token is dropped. Only `read:user` and `user:email` are asked for.
 * See https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 */

export interface GithubLoginOptions {
  clientId: string
  clientSecret: string
  /** `<public url>/api/auth/github/callback`. */
  redirectUri: string
  fetch?: typeof fetch
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createGithubLogin({
  clientId,
  clientSecret,
  redirectUri,
  fetch: fetchImpl = fetch,
}: GithubLoginOptions) {
  async function getJson(url: string, init: RequestInit): Promise<unknown> {
    let res: Response
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error',
      })
    } catch {
      throw new OidcError('could not reach GitHub')
    }
    if (!res.ok) throw new OidcError(`GitHub answered ${res.status}`)
    try {
      return await res.json()
    } catch {
      throw new OidcError('GitHub did not answer JSON')
    }
  }

  return {
    authorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', 'read:user user:email')
      url.searchParams.set('state', state)
      url.searchParams.set('allow_signup', 'false')
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.href
    },

    async exchange({
      code,
      codeVerifier,
    }: {
      code: string
      codeVerifier: string
    }): Promise<ProvenIdentity> {
      const token = await getJson(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      })
      if (!isRecord(token) || typeof token.access_token !== 'string') {
        throw new OidcError('GitHub refused the code')
      }
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.access_token}`,
        'x-github-api-version': '2022-11-28',
      }
      const user = await getJson(`${API}/user`, { headers })
      if (
        !isRecord(user) ||
        typeof user.login !== 'string' ||
        typeof user.id !== 'number' ||
        !Number.isSafeInteger(user.id) ||
        user.id <= 0
      ) {
        throw new OidcError('GitHub sent no account id')
      }
      // Only the primary email, and only when GitHub verified it. A verified secondary email
      // proves less: anyone can add one at a domain they control a mailbox of.
      const emails = await getJson(`${API}/user/emails`, { headers })
      const verifiedEmails = Array.isArray(emails)
        ? emails
            .filter(
              (e) =>
                isRecord(e) &&
                e.primary === true &&
                e.verified === true &&
                typeof e.email === 'string',
            )
            .map((e) => (e as { email: string }).email)
        : []
      return { provider: 'github', id: String(user.id), login: user.login, verifiedEmails }
    },
  }
}

export type GithubLogin = ReturnType<typeof createGithubLogin>
