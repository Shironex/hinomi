import { timingSafeEqual, webcrypto } from 'node:crypto'
import type { ProvenIdentity } from './allowlist.js'

/**
 * OpenID Connect sign in, authorization code flow with PKCE, without a library: discovery, the
 * code exchange, and the ID token checks of OIDC Core 3.1.3.7 (signature over the provider's
 * JWKS, issuer, audience, authorized party, expiry, nonce). Works with any provider that
 * publishes a discovery document: Authentik, Authelia, Google, Keycloak, Zitadel.
 */

export class OidcError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OidcError'
  }
}

export interface OidcClientOptions {
  /** HINOMI_AUTH_OIDC_ISSUER, without a trailing slash. */
  issuer: string
  clientId: string
  clientSecret: string
  /** `<public url>/api/auth/oidc/callback`. */
  redirectUri: string
  fetch?: typeof fetch
  now?: () => number
}

interface Discovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  basicAuth: boolean
  fetchedAt: number
}

const FETCH_TIMEOUT_MS = 10_000
const DISCOVERY_TTL_MS = 60 * 60 * 1000
const KEYS_TTL_MS = 60 * 60 * 1000
const REFETCH_MIN_MS = 60 * 1000
const CLOCK_SKEW_S = 60
const MAX_TOKEN_LENGTH = 16 * 1024

const ALGORITHMS = {
  RS256: {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
    kty: 'RSA',
  },
  ES256: {
    import: { name: 'ECDSA', namedCurve: 'P-256' },
    verify: { name: 'ECDSA', hash: 'SHA-256' },
    kty: 'EC',
  },
} as const
type Alg = keyof typeof ALGORITHMS

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimSlash = (value: string) => value.replace(/\/+$/, '')

/** True when `a` and `b` are equal, in time that does not depend on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function endpoint(value: unknown, issuer: string, name: string): string {
  if (typeof value !== 'string') throw new OidcError(`discovery has no ${name}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OidcError(`discovery ${name} is not a URL`)
  }
  // Same rule as the issuer: https, or http only when the issuer itself is a local http one.
  if (url.protocol !== 'https:' && new URL(issuer).protocol !== 'http:') {
    throw new OidcError(`discovery ${name} is not https`)
  }
  return url.href
}

function decodePart(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
    if (isRecord(value)) return value
  } catch {
    // fall through
  }
  throw new OidcError('malformed ID token')
}

export function createOidcClient({
  issuer,
  clientId,
  clientSecret,
  redirectUri,
  fetch: fetchImpl = fetch,
  now = Date.now,
}: OidcClientOptions) {
  let discovery: Discovery | null = null
  let keys: {
    byKid: Map<string, { alg: Alg; key: webcrypto.CryptoKey }>
    fetchedAt: number
  } | null = null
  let lastKeysAttempt = Number.NEGATIVE_INFINITY

  async function getJson(url: string, init?: RequestInit): Promise<unknown> {
    let res: Response
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { accept: 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error',
      })
    } catch {
      throw new OidcError(`could not reach ${new URL(url).host}`)
    }
    if (!res.ok) throw new OidcError(`${new URL(url).host} answered ${res.status}`)
    try {
      return await res.json()
    } catch {
      throw new OidcError(`${new URL(url).host} did not answer JSON`)
    }
  }

  async function discover(): Promise<Discovery> {
    if (discovery && now() - discovery.fetchedAt < DISCOVERY_TTL_MS) return discovery
    const body = await getJson(`${issuer}/.well-known/openid-configuration`)
    if (!isRecord(body)) throw new OidcError('discovery is not an object')
    if (typeof body.issuer !== 'string' || trimSlash(body.issuer) !== trimSlash(issuer)) {
      throw new OidcError('discovery issuer does not match HINOMI_AUTH_OIDC_ISSUER')
    }
    const methods = Array.isArray(body.token_endpoint_auth_methods_supported)
      ? body.token_endpoint_auth_methods_supported
      : ['client_secret_basic']
    discovery = {
      issuer: body.issuer,
      authorizationEndpoint: endpoint(
        body.authorization_endpoint,
        issuer,
        'authorization_endpoint',
      ),
      tokenEndpoint: endpoint(body.token_endpoint, issuer, 'token_endpoint'),
      jwksUri: endpoint(body.jwks_uri, issuer, 'jwks_uri'),
      basicAuth: methods.includes('client_secret_basic') || !methods.includes('client_secret_post'),
      fetchedAt: now(),
    }
    return discovery
  }

  async function loadKeys(jwksUri: string): Promise<void> {
    lastKeysAttempt = now()
    const body = await getJson(jwksUri)
    if (!isRecord(body) || !Array.isArray(body.keys)) throw new OidcError('JWKS has no keys')
    const byKid = new Map<string, { alg: Alg; key: webcrypto.CryptoKey }>()
    for (const jwk of body.keys) {
      if (!isRecord(jwk) || (jwk.use !== undefined && jwk.use !== 'sig')) continue
      const alg = (Object.keys(ALGORITHMS) as Alg[]).find(
        (name) =>
          ALGORITHMS[name].kty === jwk.kty &&
          (jwk.alg === undefined
            ? name === (jwk.kty === 'EC' ? 'ES256' : 'RS256')
            : jwk.alg === name),
      )
      if (!alg) continue
      try {
        const material =
          alg === 'RS256'
            ? { kty: 'RSA', n: jwk.n as string, e: jwk.e as string }
            : { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }
        const key = await webcrypto.subtle.importKey(
          'jwk',
          material,
          ALGORITHMS[alg].import,
          false,
          ['verify'],
        )
        byKid.set(typeof jwk.kid === 'string' ? jwk.kid : '', { alg, key })
      } catch {
        // A key Web Crypto cannot read is skipped; the others still work.
      }
    }
    keys = { byKid, fetchedAt: now() }
  }

  async function keyFor(jwksUri: string, kid: string | undefined, alg: Alg) {
    const pick = () => {
      if (!keys) return undefined
      if (kid !== undefined) return keys.byKid.get(kid)
      // No kid: only unambiguous when the set holds a single key of that algorithm.
      const matching = [...keys.byKid.values()].filter((entry) => entry.alg === alg)
      return matching.length === 1 ? matching[0] : undefined
    }
    const fresh = keys && now() - keys.fetchedAt < KEYS_TTL_MS
    let found = fresh ? pick() : undefined
    if (!found && now() - lastKeysAttempt >= REFETCH_MIN_MS) {
      await loadKeys(jwksUri)
      found = pick()
    }
    if (!found && keys && !fresh) found = pick()
    if (!found || found.alg !== alg) throw new OidcError('no provider key for the ID token')
    return found.key
  }

  /** Verifies the ID token and returns what it proves about the person. */
  async function verifyIdToken(
    token: string,
    nonce: string,
    d: Discovery,
  ): Promise<ProvenIdentity> {
    if (token.length > MAX_TOKEN_LENGTH) throw new OidcError('ID token too large')
    const parts = token.split('.')
    if (parts.length !== 3) throw new OidcError('malformed ID token')
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = decodePart(headerPart)
    const claims = decodePart(payloadPart)
    const alg = header.alg
    if (alg !== 'RS256' && alg !== 'ES256') throw new OidcError('unsupported ID token algorithm')
    const key = await keyFor(
      d.jwksUri,
      typeof header.kid === 'string' ? header.kid : undefined,
      alg,
    )
    const signed = await webcrypto.subtle.verify(
      ALGORITHMS[alg].verify,
      key,
      Buffer.from(signaturePart, 'base64url'),
      Buffer.from(`${headerPart}.${payloadPart}`),
    )
    if (!signed) throw new OidcError('ID token signature does not verify')

    const seconds = now() / 1000
    if (typeof claims.iss !== 'string' || trimSlash(claims.iss) !== trimSlash(issuer)) {
      throw new OidcError('ID token issuer does not match')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(clientId)) throw new OidcError('ID token is for another client')
    if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) {
      throw new OidcError('ID token authorized party is another client')
    }
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < seconds) {
      throw new OidcError('ID token expired')
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > seconds) {
      throw new OidcError('ID token issued in the future')
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) {
      throw new OidcError('ID token nonce does not match')
    }
    if (typeof claims.sub !== 'string' || claims.sub === '')
      throw new OidcError('ID token has no sub')
    const verified = claims.email_verified === true || claims.email_verified === 'true'
    return {
      provider: 'oidc',
      id: claims.sub,
      verifiedEmails: verified && typeof claims.email === 'string' ? [claims.email] : [],
    }
  }

  return {
    /** The provider's authorization URL for this login attempt. */
    async authorizationUrl(input: {
      state: string
      nonce: string
      codeChallenge: string
    }): Promise<string> {
      const d = await discover()
      const url = new URL(d.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', 'openid email profile')
      url.searchParams.set('state', input.state)
      url.searchParams.set('nonce', input.nonce)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.href
    },

    /** Trades the code for tokens and verifies the ID token. The tokens are not kept. */
    async exchange(input: {
      code: string
      codeVerifier: string
      nonce: string
    }): Promise<ProvenIdentity> {
      const d = await discover()
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: redirectUri,
        code_verifier: input.codeVerifier,
      })
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
      }
      if (d.basicAuth) {
        const user = encodeURIComponent(clientId)
        const pass = encodeURIComponent(clientSecret)
        headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      } else {
        form.set('client_id', clientId)
        form.set('client_secret', clientSecret)
      }
      const body = await getJson(d.tokenEndpoint, { method: 'POST', headers, body: form })
      if (!isRecord(body) || typeof body.id_token !== 'string') {
        throw new OidcError('token answer has no id_token')
      }
      return verifyIdToken(body.id_token, input.nonce, d)
    },
  }
}

export type OidcClient = ReturnType<typeof createOidcClient>
