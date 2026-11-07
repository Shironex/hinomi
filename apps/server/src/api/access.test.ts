import { accessStatusSchema, type AccessStatus, nowMs } from '@hinomi/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createCfAccessVerifier,
  createIpMatcher,
  decodeHeaderWord,
  type AccessOptions,
} from '../access/index.js'
import {
  accessClaims,
  AUDIENCE,
  certsFetch,
  createSigner,
  TEAM_DOMAIN,
  type TestSigner,
} from '../access/testing.js'
import { createApp } from '../app.js'

const TAILNET = '100.100.7.8'
const PUBLIC = '203.0.113.9'
const BRIDGE = '172.18.0.1'
const PROXY = '172.20.0.5'

/**
 * GET /api/access as the Node server would run it: the socket peer goes in through the
 * node-server bindings that getConnInfo reads, never through a header.
 */
async function access(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
  options: AccessOptions = {},
): Promise<AccessStatus> {
  const env = { incoming: { socket: { remoteAddress, remotePort: 51234, remoteFamily: 'IPv4' } } }
  const res = await createApp({ access: options }).request('/api/access', { headers }, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return accessStatusSchema.parse(await res.json())
}

describe('GET /api/access', () => {
  let signer: TestSigner
  let forger: TestSigner
  const verifierOptions = (): AccessOptions => ({
    cfAccess: createCfAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      fetch: certsFetch(() => [signer.jwk]).fetch,
    }),
  })

  beforeAll(async () => {
    signer = await createSigner()
    forger = await createSigner()
  })

  describe('tailscale', () => {
    it('detects a client in the Tailscale range', async () => {
      expect(await access(TAILNET)).toEqual({
        state: 'tailscale',
        address: TAILNET,
        forwarded: false,
        via: 'address',
        login: null,
      })
      expect(await access('fd7a:115c:a1e0::9')).toMatchObject({ state: 'tailscale' })
      expect(await access(`::ffff:${TAILNET}`)).toMatchObject({
        state: 'tailscale',
        address: TAILNET,
      })
    })

    it('reads the login from tailscale serve on loopback', async () => {
      expect(
        await access('127.0.0.1', {
          'Tailscale-User-Login': 'ops@example.dev',
          'Tailscale-User-Name': 'Kestrel Ops',
        }),
      ).toEqual({
        state: 'tailscale',
        address: '127.0.0.1',
        forwarded: false,
        via: 'serve',
        login: 'ops@example.dev',
      })
    })

    it('ignores identity headers a tailnet client sends itself', async () => {
      expect(await access(TAILNET, { 'Tailscale-User-Login': 'boss@example.dev' })).toMatchObject({
        state: 'tailscale',
        via: 'address',
        login: null,
      })
    })

    it('ignores identity headers from a public or bridge address', async () => {
      expect(await access(PUBLIC, { 'Tailscale-User-Login': 'ops@example.dev' })).toMatchObject({
        state: 'public',
      })
      expect(await access(BRIDGE, { 'Tailscale-User-Login': 'ops@example.dev' })).toMatchObject({
        state: 'unknown',
      })
    })

    it('believes identity headers from a trusted proxy', async () => {
      expect(
        await access(
          PROXY,
          { 'Tailscale-User-Login': 'ops@example.dev' },
          { isTrustedProxy: createIpMatcher([PROXY]) },
        ),
      ).toMatchObject({ state: 'tailscale', via: 'serve', login: 'ops@example.dev' })
    })
  })

  describe('cloudflare_access', () => {
    it('reports a verified token with its email', async () => {
      const token = await signer.sign(accessClaims(nowMs()))
      expect(await access(BRIDGE, { 'Cf-Access-Jwt-Assertion': token }, verifierOptions())).toEqual(
        {
          state: 'cloudflare_access',
          address: BRIDGE,
          forwarded: false,
          verified: true,
          unverifiedReason: null,
          email: 'ops@example.dev',
        },
      )
    })

    it('reports the header as seen but not verified without a team domain', async () => {
      expect(await access(BRIDGE, { 'Cf-Access-Jwt-Assertion': 'a.b.c' })).toEqual({
        state: 'cloudflare_access',
        address: BRIDGE,
        forwarded: false,
        verified: false,
        unverifiedReason: 'not_configured',
        email: null,
      })
    })

    it('reports certs_unavailable when the certs cannot be read', async () => {
      const options: AccessOptions = {
        cfAccess: createCfAccessVerifier({
          teamDomain: TEAM_DOMAIN,
          audience: AUDIENCE,
          fetch: certsFetch(() => 'down').fetch,
        }),
      }
      const token = await signer.sign(accessClaims(nowMs()))
      expect(await access(BRIDGE, { 'Cf-Access-Jwt-Assertion': token }, options)).toMatchObject({
        state: 'cloudflare_access',
        verified: false,
        unverifiedReason: 'certs_unavailable',
      })
    })

    it('ignores a forged token when verification is on', async () => {
      const forged = await forger.sign(accessClaims(nowMs()))
      expect(
        await access(PUBLIC, { 'Cf-Access-Jwt-Assertion': forged }, verifierOptions()),
      ).toEqual({ state: 'public', address: PUBLIC, forwarded: false })
      expect(
        await access(BRIDGE, { 'Cf-Access-Jwt-Assertion': 'junk' }, verifierOptions()),
      ).toMatchObject({ state: 'unknown' })
    })

    it('ranks a verified token above a Tailscale address', async () => {
      const token = await signer.sign(accessClaims(nowMs()))
      expect(
        await access(TAILNET, { 'Cf-Access-Jwt-Assertion': token }, verifierOptions()),
      ).toMatchObject({ state: 'cloudflare_access', verified: true })
    })
  })

  describe('public', () => {
    it('flags a public client address', async () => {
      expect(await access(PUBLIC)).toEqual({ state: 'public', address: PUBLIC, forwarded: false })
      expect(await access('2001:db8::7')).toMatchObject({ state: 'public' })
    })
  })

  describe('unknown', () => {
    it('cannot tell behind a Docker bridge, a LAN or loopback', async () => {
      expect(await access(BRIDGE)).toEqual({
        state: 'unknown',
        address: BRIDGE,
        forwarded: false,
        reason: 'private_address',
      })
      expect(await access('192.168.1.20')).toMatchObject({ reason: 'private_address' })
      expect(await access('127.0.0.1')).toMatchObject({ state: 'unknown', reason: 'loopback' })
    })

    it('says so when there is no socket address (not the Node server)', async () => {
      const res = await createApp().request('/api/access')
      expect(accessStatusSchema.parse(await res.json())).toEqual({
        state: 'unknown',
        address: null,
        forwarded: false,
        reason: 'no_address',
      })
    })
  })

  describe('forwarded headers', () => {
    const trusted: AccessOptions = { isTrustedProxy: createIpMatcher(['172.20.0.0/16']) }

    it('ignores X-Forwarded-For and CF-Connecting-IP without a trusted proxy', async () => {
      const spoof = { 'X-Forwarded-For': TAILNET, 'CF-Connecting-IP': TAILNET }
      expect(await access(PUBLIC, spoof)).toEqual({
        state: 'public',
        address: PUBLIC,
        forwarded: false,
      })
      expect(await access(BRIDGE, spoof)).toMatchObject({ state: 'unknown', address: BRIDGE })
    })

    it('ignores them from a peer that is not the trusted proxy', async () => {
      expect(await access(PUBLIC, { 'X-Forwarded-For': TAILNET }, trusted)).toMatchObject({
        state: 'public',
        address: PUBLIC,
      })
    })

    it('takes the right most untrusted X-Forwarded-For entry from a trusted proxy', async () => {
      expect(await access(PROXY, { 'X-Forwarded-For': TAILNET }, trusted)).toEqual({
        state: 'tailscale',
        address: TAILNET,
        forwarded: true,
        via: 'address',
        login: null,
      })
      // The client wrote the left entry; the proxy appended the real one.
      expect(
        await access(PROXY, { 'X-Forwarded-For': `${TAILNET}, ${PUBLIC}, 172.20.0.9` }, trusted),
      ).toMatchObject({ state: 'public', address: PUBLIC, forwarded: true })
    })

    it('falls back to CF-Connecting-IP, then to the proxy itself', async () => {
      expect(await access(PROXY, { 'CF-Connecting-IP': PUBLIC }, trusted)).toMatchObject({
        state: 'public',
        address: PUBLIC,
        forwarded: true,
      })
      expect(await access(PROXY, {}, trusted)).toMatchObject({
        state: 'unknown',
        address: PROXY,
        forwarded: false,
      })
    })
  })
})

describe('decodeHeaderWord', () => {
  it('decodes RFC 2047 Q words that tailscale serve sends for non ASCII values', () => {
    expect(decodeHeaderWord('=?utf-8?q?Ferris_B=C3=BCller?=')).toBe('Ferris Büller')
    expect(decodeHeaderWord('ops@example.dev')).toBe('ops@example.dev')
  })
})
