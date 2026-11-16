import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createOidcClient, OidcError, safeEqual } from './oidc.js'
import {
  createFakeIdp,
  IDP_CLIENT_ID,
  IDP_CLIENT_SECRET,
  IDP_ISSUER,
  recordAuthorization,
} from './testing.js'

function client(fetchImpl: typeof fetch) {
  return createOidcClient({
    issuer: IDP_ISSUER,
    clientId: IDP_CLIENT_ID,
    clientSecret: IDP_CLIENT_SECRET,
    redirectUri: 'https://hinomi.example.dev/api/auth/oidc/callback',
    fetch: fetchImpl,
  })
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
