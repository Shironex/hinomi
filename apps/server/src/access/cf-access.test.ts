import { beforeAll, describe, expect, it } from 'vitest'
import { createCfAccessVerifier, normalizeTeamDomain } from './cf-access.js'
import {
  accessClaims,
  AUDIENCE,
  certsFetch,
  createSigner,
  TEAM_DOMAIN,
  type CertsKeys,
  type TestSigner,
} from './testing.js'

const NOW = Date.parse('2026-11-05T10:00:00Z')

describe('normalizeTeamDomain', () => {
  it('accepts a team name, a host or an https URL', () => {
    expect(normalizeTeamDomain('kestrel-co')).toBe(TEAM_DOMAIN)
    expect(normalizeTeamDomain('kestrel-co.cloudflareaccess.com')).toBe(TEAM_DOMAIN)
    expect(normalizeTeamDomain('https://kestrel-co.cloudflareaccess.com/')).toBe(TEAM_DOMAIN)
  })

  it('rejects plain http and paths', () => {
    expect(normalizeTeamDomain('http://kestrel-co.cloudflareaccess.com')).toBeNull()
    expect(normalizeTeamDomain('https://kestrel-co.cloudflareaccess.com/cdn-cgi')).toBeNull()
  })
})

describe('createCfAccessVerifier', () => {
  let signer: TestSigner
  let other: TestSigner

  beforeAll(async () => {
    signer = await createSigner('kid-current')
    other = await createSigner('kid-current')
  })

  function verifier(keys: () => CertsKeys, now = () => NOW) {
    const certs = certsFetch(keys)
    return {
      ...certs,
      verifier: createCfAccessVerifier({
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        fetch: certs.fetch,
        now,
      }),
    }
  }

  it('accepts a token Access signed for this app and returns the email', async () => {
    const { verifier: v, calls } = verifier(() => [signer.jwk])
    const token = await signer.sign(accessClaims(NOW))
    expect(await v.verify(token)).toEqual({ status: 'valid', email: 'ops@example.dev' })
    expect(await v.verify(token)).toEqual({ status: 'valid', email: 'ops@example.dev' })
    expect(calls).toEqual([`${TEAM_DOMAIN}/cdn-cgi/access/certs`])
  })

  it('rejects a token signed by another key with the same kid', async () => {
    const { verifier: v } = verifier(() => [signer.jwk])
    expect(await v.verify(await other.sign(accessClaims(NOW)))).toEqual({ status: 'invalid' })
  })

  it('rejects a token whose payload was changed after signing', async () => {
    const { verifier: v } = verifier(() => [signer.jwk])
    const [head, , sig] = (await signer.sign(accessClaims(NOW))).split('.')
    const forged = Buffer.from(
      JSON.stringify(accessClaims(NOW, { email: 'x@example.dev' })),
    ).toString('base64url')
    expect(await v.verify(`${head}.${forged}.${sig}`)).toEqual({ status: 'invalid' })
  })

  it('checks audience, issuer, expiry and not before', async () => {
    const { verifier: v } = verifier(() => [signer.jwk])
    const cases = [
      accessClaims(NOW, { aud: ['another-app'] }),
      accessClaims(NOW, { iss: 'https://other-team.cloudflareaccess.com' }),
      accessClaims(NOW, { exp: NOW / 1000 - 120 }),
      accessClaims(NOW, { exp: undefined }),
      accessClaims(NOW, { nbf: NOW / 1000 + 600 }),
    ]
    for (const claims of cases) {
      expect(await v.verify(await signer.sign(claims))).toEqual({ status: 'invalid' })
    }
    // A string aud is allowed, and a minute of clock skew.
    expect(await v.verify(await signer.sign(accessClaims(NOW, { aud: AUDIENCE })))).toMatchObject({
      status: 'valid',
    })
    expect(
      await v.verify(await signer.sign(accessClaims(NOW, { exp: NOW / 1000 - 30 }))),
    ).toMatchObject({ status: 'valid' })
  })

  it('rejects other algorithms and junk without fetching', async () => {
    const { verifier: v, calls } = verifier(() => [signer.jwk])
    const none = `${Buffer.from('{"alg":"none","kid":"kid-current"}').toString('base64url')}.${Buffer.from(JSON.stringify(accessClaims(NOW))).toString('base64url')}.`
    expect(await v.verify(none)).toEqual({ status: 'invalid' })
    expect(await v.verify(await signer.sign(accessClaims(NOW), { alg: 'HS256' }))).toEqual({
      status: 'invalid',
    })
    expect(await v.verify('not-a-jwt')).toEqual({ status: 'invalid' })
    expect(await v.verify('a.b.c')).toEqual({ status: 'invalid' })
    expect(await v.verify('x'.repeat(20_000))).toEqual({ status: 'invalid' })
    expect(calls).toEqual([])
  })

  it('refetches the certs for a new kid after a rotation, at most once a minute', async () => {
    let now = NOW
    let keys: CertsKeys = [signer.jwk]
    const rotated = await createSigner('kid-next')
    const { verifier: v, calls } = verifier(
      () => keys,
      () => now,
    )
    expect((await v.verify(await signer.sign(accessClaims(now)))).status).toBe('valid')
    keys = [signer.jwk, rotated.jwk]
    // Within a minute of the last fetch an unknown kid is not refetched.
    now += 10_000
    expect(await v.verify(await rotated.sign(accessClaims(now)))).toEqual({ status: 'invalid' })
    expect(calls).toHaveLength(1)
    now += 60_000
    expect((await v.verify(await rotated.sign(accessClaims(now)))).status).toBe('valid')
    expect(calls).toHaveLength(2)
  })

  it('reports unavailable when the certs cannot be fetched, and keeps old keys on a failed refresh', async () => {
    let now = NOW
    let keys: CertsKeys = 'down'
    const { verifier: v } = verifier(
      () => keys,
      () => now,
    )
    expect(await v.verify(await signer.sign(accessClaims(now)))).toEqual({ status: 'unavailable' })
    keys = [signer.jwk]
    now += 61_000
    expect((await v.verify(await signer.sign(accessClaims(now)))).status).toBe('valid')
    keys = 'down'
    now += 2 * 60 * 60 * 1000
    expect((await v.verify(await signer.sign(accessClaims(now)))).status).toBe('valid')
  })
})
