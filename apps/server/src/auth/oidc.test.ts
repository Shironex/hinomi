import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { nowMs } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createOidcClient, OidcError, safeEqual } from './oidc.js'
import {
  createFakeIdp,
  type FakeIdp,
  IDP_CLIENT_ID,
  IDP_CLIENT_SECRET,
  IDP_ISSUER,
  recordAuthorization,
} from './testing.js'

function client(fetchImpl: typeof fetch, tokenOrigin: string | null = null) {
  return createOidcClient({
    issuer: IDP_ISSUER,
    clientId: IDP_CLIENT_ID,
    clientSecret: IDP_CLIENT_SECRET,
    redirectUri: 'https://hinomi.example.dev/api/auth/oidc/callback',
    tokenOrigin,
    fetch: fetchImpl,
  })
}

/** One full login against the fake provider, with the ID token changed. */
async function loginWith(
  claims: Record<string, unknown>,
  token: Pick<FakeIdp, 'header' | 'signToken'> = { header: {}, signToken: null },
) {
  const idp = createFakeIdp()
  idp.claims = claims
  idp.header = token.header
  idp.signToken = token.signToken
  const oidc = client(idp.fetch)
  const url = await oidc.authorizationUrl({ state: 's1', nonce: 'n1', codeChallenge: 'pkce' })
  recordAuthorization(idp, url.replace('code_challenge=pkce', `code_challenge=${s256('v1')}`))
  return oidc.exchange({ code: 's1', codeVerifier: 'v1', nonce: 'n1' })
}

/** The fake provider, with its discovery document changed. */
function rediscover(change: Record<string, unknown>): typeof fetch {
  const idp = createFakeIdp()
  return async (input, init) => {
    const res = await idp.fetch(input, init)
    if (!urlOf(input).includes('openid-configuration')) return res
    const body = (await res.json()) as Record<string, unknown>
    return new Response(JSON.stringify({ ...body, ...change }))
  }
}

const urlOf = (input: string | URL | Request) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

describe('createOidcClient', () => {
  it('signs in through discovery, the code exchange and the ID token checks', async () => {
    const idp = createFakeIdp()
    const oidc = client(idp.fetch)
    const url = await oidc.authorizationUrl({ state: 's1', nonce: 'n1', codeChallenge: 'pkce' })
    recordAuthorization(idp, url.replace('code_challenge=pkce', `code_challenge=${s256('v1')}`))
    expect(await oidc.exchange({ code: 's1', codeVerifier: 'v1', nonce: 'n1' })).toEqual({
      provider: 'oidc',
      id: 'user-7f3a',
      verifiedEmails: ['ops@example.dev'],
    })
    // Discovery and keys are cached between logins.
    await oidc.authorizationUrl({ state: 's2', nonce: 'n2', codeChallenge: 'x' })
    expect(idp.calls.filter((c) => c.includes('openid-configuration'))).toHaveLength(1)
  })

  it('refuses a discovery document for another issuer', async () => {
    const idp = createFakeIdp()
    const evil: typeof fetch = async (input, init) => {
      const res = await idp.fetch(input, init)
      if (!urlOf(input).includes('openid-configuration')) return res
      const body = (await res.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...body, issuer: 'https://evil.example.dev' }))
    }
    await expect(
      client(evil).authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toThrow('discovery issuer does not match')
  })

  it('refuses http endpoints from an https issuer', async () => {
    const idp = createFakeIdp()
    const downgrade: typeof fetch = async (input, init) => {
      const res = await idp.fetch(input, init)
      if (!urlOf(input).includes('openid-configuration')) return res
      const body = (await res.json()) as Record<string, unknown>
      return new Response(
        JSON.stringify({ ...body, token_endpoint: 'http://id.example.dev/token' }),
      )
    }
    await expect(
      client(downgrade).authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toThrow(OidcError)
  })

  it('compares the ID token issuer exactly as discovered', async () => {
    // Discovery says ".../hinomi/" (trailing slash); a token without it is another issuer.
    await expect(loginWith({ iss: IDP_ISSUER })).rejects.toThrow('ID token issuer does not match')
    await expect(loginWith({ iss: `${IDP_ISSUER}//` })).rejects.toThrow(
      'ID token issuer does not match',
    )
  })

  it.each([
    ['no iat', { iat: undefined }, 'ID token has no iat'],
    ['an iat in the future', { iat: Math.floor(nowMs() / 1000) + 600 }, 'issued in the future'],
    ['an iat an hour old', { iat: Math.floor(nowMs() / 1000) - 3600 }, 'issued too long ago'],
  ])('refuses an ID token with %s', async (_why, claims, message) => {
    await expect(loginWith(claims)).rejects.toThrow(message)
  })

  describe('refuses a forged or malformed ID token', () => {
    const now = () => Math.floor(nowMs() / 1000)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

    it.each([
      [
        'alg none',
        { header: { alg: 'none' }, signToken: () => Buffer.alloc(0) },
        'unsupported ID token algorithm',
      ],
      [
        'HS256 keyed with the public key',
        {
          header: { alg: 'HS256' },
          signToken: (input: Buffer) =>
            createHmac('sha256', 'public-key-as-secret').update(input).digest(),
        },
        'unsupported ID token algorithm',
      ],
      [
        'RS256 over the EC key',
        {
          header: { alg: 'RS256', kid: 'k1' },
          signToken: (input: Buffer) => sign('sha256', input, rsa),
        },
        'no provider key for the ID token',
      ],
      [
        'an unknown kid',
        { header: { kid: 'k9' }, signToken: null },
        'no provider key for the ID token',
      ],
    ])('with %s', async (_why, token, message) => {
      await expect(loginWith({}, token)).rejects.toThrow(message)
    })

    it.each([
      ['an aud array without azp', { aud: [IDP_CLIENT_ID, 'other-client'] }, 'authorized party'],
      [
        'a wrong azp',
        { aud: [IDP_CLIENT_ID, 'other-client'], azp: 'other-client' },
        'authorized party',
      ],
      ['a string exp', { exp: String(now() + 300) }, 'ID token expired'],
      ['a string iat', { iat: String(now()) }, 'ID token has no iat'],
      ['no nonce', { nonce: undefined }, 'ID token nonce does not match'],
    ])('with %s', async (_why, claims, message) => {
      await expect(loginWith(claims)).rejects.toThrow(message)
    })
  })

  it('refuses discovery endpoints that are neither http nor https', async () => {
    const local = createFakeIdp()
    const oidc = createOidcClient({
      issuer: 'http://localhost:9000/hinomi',
      clientId: IDP_CLIENT_ID,
      clientSecret: IDP_CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/api/auth/oidc/callback',
      tokenOrigin: null,
      fetch: (input) => {
        if (!urlOf(input).includes('openid-configuration')) return local.fetch(input)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: 'http://localhost:9000/hinomi',
              authorization_endpoint: 'data:text/html,<p>hi</p>',
              token_endpoint: 'http://localhost:9000/token',
              jwks_uri: 'http://localhost:9000/jwks',
            }),
          ),
        )
      },
    })
    await expect(
      oidc.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toThrow('discovery authorization_endpoint is not https')
  })

  it('refuses a token endpoint off the issuer origin unless it is configured', async () => {
    const elsewhere = rediscover({ token_endpoint: 'https://oauth2.example.net/token' })
    await expect(
      client(elsewhere).authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toThrow(
      "discovery token_endpoint is on https://oauth2.example.net, not the issuer's origin; set HINOMI_AUTH_OIDC_TOKEN_ORIGIN to allow it",
    )
    await expect(
      client(elsewhere, 'https://oauth2.example.net').authorizationUrl({
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
      }),
    ).resolves.toMatch(/^https:\/\/id\.example\.dev\/authorize\?/)
  })

  it('fails closed when the provider cannot be reached', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    await expect(
      client(down).authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    ).rejects.toThrow('could not reach id.example.dev')
  })
})

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

/** Same as the server: base64url(SHA-256(verifier)). */
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
