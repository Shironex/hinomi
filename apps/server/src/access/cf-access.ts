import { webcrypto } from 'node:crypto'

/**
 * Verifies the Cloudflare Access application token (the Cf-Access-Jwt-Assertion
 * request header) without a JWT library: RS256 over the JWKS at
 * `<team domain>/cdn-cgi/access/certs`, then issuer, audience and expiry.
 * See https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */

export type CfAccessResult =
  | { status: 'valid'; email: string | null }
  /** Malformed, badly signed, for another app or team, or expired: treat as spoofed. */
  | { status: 'invalid' }
  /** The certs could not be fetched, so the token could not be checked either way. */
  | { status: 'unavailable' }

export interface CfAccessVerifier {
  verify(token: string): Promise<CfAccessResult>
}

export interface CfAccessVerifierOptions {
  /** Team domain as an https origin, for example `https://kestrel-co.cloudflareaccess.com`. */
  teamDomain: string
  /** Application Audience (AUD) tag of the Access application. */
  audience: string
  fetch?: typeof fetch
  now?: () => number
}

/** Cloudflare rotates keys every 6 weeks and keeps the old one valid for 7 days. */
const KEYS_TTL_MS = 60 * 60 * 1000
/** An unknown kid refetches the certs, but no more often than this, so junk tokens cannot flood Cloudflare. */
const REFETCH_MIN_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 5000
const CLOCK_SKEW_S = 60
/** Real tokens are around 1 KiB; anything far larger is not one. */
const MAX_TOKEN_LENGTH = 16 * 1024

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

interface KeySet {
  keys: Map<string, webcrypto.CryptoKey>
  fetchedAt: number
}

function base64urlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes HINOMI_CF_ACCESS_TEAM_DOMAIN: a bare team name (`kestrel-co`), a host
 * (`kestrel-co.cloudflareaccess.com`) or an https URL all become the https origin.
 * Returns null for anything else.
 */
export function normalizeTeamDomain(value: string): string | null {
  let raw = value.trim().replace(/\/+$/, '')
  if (/^[a-z0-9-]+$/i.test(raw)) raw = `${raw}.cloudflareaccess.com`
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.username) return null
    return url.origin
  } catch {
    return null
  }
}

export function createCfAccessVerifier({
  teamDomain,
  audience,
  fetch: fetchImpl = fetch,
  now = Date.now,
}: CfAccessVerifierOptions): CfAccessVerifier {
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`
  let keySet: KeySet | null = null
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<KeySet | null> | null = null

  async function fetchKeys(): Promise<KeySet | null> {
    lastAttemptAt = now()
    try {
      const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) return null
      const body: unknown = await res.json()
      if (!isRecord(body) || !Array.isArray(body.keys)) return null
      const keys = new Map<string, webcrypto.CryptoKey>()
      for (const jwk of body.keys) {
        if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
        if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue
        try {
          const key = await webcrypto.subtle.importKey(
            'jwk',
            { kty: 'RSA', n: jwk.n, e: jwk.e },
            RS256,
            false,
            ['verify'],
          )
          keys.set(jwk.kid, key)
        } catch {
          // A key Web Crypto cannot read is skipped; the others still work.
        }
      }
      return { keys, fetchedAt: now() }
    } catch {
      return null
    }
  }

  /**
   * The key for `kid`. Refetches when the cache is older than an hour or the kid is
   * new (a rotation), at most once a minute. A failed refetch keeps the old keys.
   */
  async function keyFor(kid: string): Promise<webcrypto.CryptoKey | 'unavailable' | null> {
    const age = keySet ? now() - keySet.fetchedAt : Number.POSITIVE_INFINITY
    const cached = keySet?.keys.get(kid)
    if (cached && age < KEYS_TTL_MS) return cached
    if (inflight || now() - lastAttemptAt >= REFETCH_MIN_MS) {
      inflight ??= fetchKeys().finally(() => {
        inflight = null
      })
      const next = await inflight
      if (next) keySet = next
    }
    if (!keySet) return 'unavailable'
    return keySet.keys.get(kid) ?? null
  }

  async function verify(token: string): Promise<CfAccessResult> {
    if (token.length > MAX_TOKEN_LENGTH) return { status: 'invalid' }
    const parts = token.split('.')
    if (parts.length !== 3) return { status: 'invalid' }
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = base64urlJson(headerPart)
    const payload = base64urlJson(payloadPart)
    if (!isRecord(header) || !isRecord(payload)) return { status: 'invalid' }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { status: 'invalid' }

    const key = await keyFor(header.kid)
    if (key === 'unavailable') return { status: 'unavailable' }
    if (key === null) return { status: 'invalid' }

    const signed = await webcrypto.subtle.verify(
      RS256,
      key,
      Buffer.from(signaturePart, 'base64url'),
      Buffer.from(`${headerPart}.${payloadPart}`),
    )
    if (!signed) return { status: 'invalid' }

    const seconds = now() / 1000
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (payload.iss !== teamDomain) return { status: 'invalid' }
    if (!audiences.includes(audience)) return { status: 'invalid' }
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < seconds) {
      return { status: 'invalid' }
    }
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > seconds) {
      return { status: 'invalid' }
    }
    return { status: 'valid', email: typeof payload.email === 'string' ? payload.email : null }
  }

  return { verify }
}
