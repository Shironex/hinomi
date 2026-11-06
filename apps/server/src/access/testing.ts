import { webcrypto } from 'node:crypto'

/** A fictional Access team and app for tests. */
export const TEAM_DOMAIN = 'https://kestrel-co.cloudflareaccess.com'
export const AUDIENCE = 'aud-tag-of-the-hinomi-app'

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

export interface TestSigner {
  kid: string
  jwk: webcrypto.JsonWebKey
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** An RSA key pair standing in for the account's Access signing key. */
export async function createSigner(kid = 'kid-current'): Promise<TestSigner> {
  const pair = await webcrypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )
  const jwk = { ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256' }
  return {
    kid,
    jwk,
    async sign(payload, header = {}) {
      const head = b64({ alg: 'RS256', kid, typ: 'JWT', ...header })
      const body = b64(payload)
      const sig = await webcrypto.subtle.sign(
        RS256,
        pair.privateKey,
        Buffer.from(`${head}.${body}`),
      )
      return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`
    },
  }
}

/** Claims of a token Access would issue for the test app, valid for an hour from `nowMs`. */
export function accessClaims(nowMs: number, over: Record<string, unknown> = {}) {
  const iat = Math.floor(nowMs / 1000)
  return {
    aud: [AUDIENCE],
    email: 'ops@example.dev',
    exp: iat + 3600,
    iat,
    nbf: iat,
    iss: TEAM_DOMAIN,
    type: 'app',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    ...over,
  }
}

/** Keys the fake certs endpoint serves, or `down` for a network failure. */
export type CertsKeys = webcrypto.JsonWebKey[] | 'down'

/** A fetch that serves `keys` at the team's certs URL and counts the calls. */
export function certsFetch(getKeys: () => CertsKeys) {
  const calls: string[] = []
  const fetchImpl = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(url)
    const keys = getKeys()
    if (keys === 'down') return Promise.reject(new Error('connect ECONNREFUSED'))
    if (url !== `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      return Promise.resolve(new Response('not found', { status: 404 }))
    }
    return Promise.resolve(Response.json({ keys, public_certs: [] }))
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}
