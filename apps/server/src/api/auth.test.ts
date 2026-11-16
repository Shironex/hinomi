import {
  auditResponseSchema,
  authSessionSchema,
  authSessionsResponseSchema,
  passkeyCreationOptionsSchema,
  passkeyRequestOptionsSchema,
  passkeysResponseSchema,
  setupCodeResponseSchema,
  type AuthSession,
  currentTime,
  nowMs,
} from '@hinomi/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createAuthCore,
  issueSetupCode,
  parseAllowRules,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from '../auth/index.js'
import {
  createFakeIdp,
  createSoftAuthenticator,
  IDP_CLIENT_ID,
  IDP_CLIENT_SECRET,
  IDP_ISSUER,
  recordAuthorization,
  type FakeIdp,
  type SoftAuthenticator,
} from '../auth/testing.js'
import type { AuthConfig } from '../config.js'
import { createTestApi } from './testing.js'

const ORIGIN = 'https://hinomi.example.dev'
const COOKIE = '__Host-hinomi_session'

function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicOrigin: ORIGIN,
    secure: true,
    rpId: 'hinomi.example.dev',
    oidc: {
      issuer: IDP_ISSUER,
      clientId: IDP_CLIENT_ID,
      clientSecret: IDP_CLIENT_SECRET,
      name: 'Kestrel ID',
      tokenOrigin: null,
    },
    github: { clientId: 'gh-client', clientSecret: 'gh-secret-fictional-0001' },
    allowed: parseAllowRules('ops@example.dev, github:kestrel-ops'),
    ...overrides,
  }
}

interface Answer {
  status: number
  headers: Headers
  json: unknown
  setCookies: string[]
}

/**
 * A browser for app.request: keeps cookies, sends the public Origin and, once signed in, the CSRF
 * token, unless a call says otherwise.
 */
function browser(app: ReturnType<typeof createTestApi>['app'], ip?: string) {
  const jar = new Map<string, string>()
  let csrf: string | null = null

  async function call(
    method: string,
    path: string,
    {
      body,
      origin = ORIGIN,
      sendCsrf = true,
      headers = {},
    }: {
      body?: unknown
      origin?: string | null
      sendCsrf?: boolean
      headers?: Record<string, string>
    } = {},
  ): Promise<Answer> {
    const h = new Headers(headers)
    if (jar.size > 0) h.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    if (origin && method !== 'GET') h.set('origin', origin)
    if (sendCsrf && csrf && method !== 'GET') h.set('x-hinomi-csrf', csrf)
    if (body !== undefined) h.set('content-type', 'application/json')
    // The socket peer, as the Node server would hand it to getConnInfo.
    const env = ip
      ? {
          incoming: {
            socket: {
              remoteAddress: ip,
              remoteFamily: ip.includes(':') ? 'IPv6' : 'IPv4',
              remotePort: 40000,
            },
          },
        }
      : undefined
    const res = await app.request(
      path,
      { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    )
    const setCookies = res.headers.getSetCookie()
    for (const line of setCookies) {
      const [pair] = line.split(';')
      const eq = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, eq)
      const value = (pair ?? '').slice(eq + 1)
      if (/max-age=0/i.test(line) || value === '') jar.delete(name)
      else jar.set(name, value)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined
    } catch {
      json = text
    }
    return { status: res.status, headers: res.headers, json, setCookies }
  }

  return {
    jar,
    call,
    async session(): Promise<AuthSession> {
      const res = await call('GET', '/api/auth/session')
      const body = authSessionSchema.parse(res.json)
      csrf = body.session?.csrfToken ?? null
      return body
    },
    setCsrf(value: string | null) {
      csrf = value
    },
  }
}

function setup({
  config = authConfig(),
  clock = { now: nowMs() },
}: { config?: AuthConfig | null; clock?: { now: number } } = {}) {
  const idp = createFakeIdp()
  const api = createTestApi({ auth: { config, now: () => new Date(clock.now), fetch: idp.fetch } })
  return { ...api, idp, clock, b: browser(api.app) }
}

type World = ReturnType<typeof setup>

/** Registers a passkey with a fresh setup code and leaves the browser signed in. */
async function enroll(w: World, b = w.b, name = 'MacBook'): Promise<SoftAuthenticator> {
  const authenticator = createSoftAuthenticator({ origin: ORIGIN })
  const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
  const verify = await b.call('POST', '/api/auth/setup/verify', { body: { code } })
  expect(verify.status).toBe(200)
  const { enrollmentId, options } = setupCodeResponseSchema.parse(verify.json)
  const register = await b.call('POST', '/api/auth/setup/register', {
    body: { enrollmentId, name, credential: authenticator.register(options) },
  })
  expect(register.status).toBe(204)
  await b.session()
  return authenticator
}

async function passkeyLogin(w: World, authenticator: SoftAuthenticator, b = w.b, overrides = {}) {
  const options = passkeyRequestOptionsSchema.parse(
    (await b.call('POST', '/api/auth/passkey/login/options')).json,
  )
  return b.call('POST', '/api/auth/passkey/login', {
    body: { credential: authenticator.assert(options, overrides) },
  })
}

describe('built in login off (the default)', () => {
  it('leaves every route open and says so', async () => {
    const w = setup({ config: null })
    expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
    expect(await w.b.session()).toEqual({
      enabled: false,
      methods: { oidc: null, github: false, passkey: false },
      session: null,
    })
    const health = await w.b.call('GET', '/api/health')
    expect(health.json).toEqual({ status: 'ok', version: 'dev' })
    // No login routes exist while it is off.
    expect((await w.b.call('POST', '/api/auth/setup/verify', { body: { code: 'x' } })).status).toBe(
      404,
    )
  })

  it('still writes changes to the audit log, without an actor', async () => {
    const w = setup({ config: null })
    expect((await w.b.call('PATCH', '/api/settings', { body: { osvEnabled: false } })).status).toBe(
      200,
    )
    const audit = auditResponseSchema.parse((await w.b.call('GET', '/api/audit')).json)
    expect(
      audit.events.map(({ action, actor, ip, httpMethod, path, status, detail }) => ({
        action,
        actor,
        ip,
        httpMethod,
        path,
        status,
        detail,
      })),
    ).toEqual([
      {
        action: 'change',
        actor: null,
        ip: null,
        httpMethod: 'PATCH',
        path: '/api/settings',
        status: 200,
        detail: null,
      },
    ])
  })
})

describe('built in login on', () => {
  it('refuses the API without a session and keeps health silent', async () => {
    const w = setup()
    const res = await w.b.call('GET', '/api/overview')
    expect(res.status).toBe(401)
    expect(res.json).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to Hinomi first' },
    })
    expect((await w.b.call('GET', '/api/version')).status).toBe(401)
    expect((await w.b.call('GET', '/api/access')).status).toBe(401)
    // Unknown paths too, so nothing can be probed.
    expect((await w.b.call('GET', '/api/no-such-route')).status).toBe(401)
    expect((await w.b.call('GET', '/api/health')).json).toEqual({ status: 'ok' })
    expect(await w.b.session()).toEqual({
      enabled: true,
      methods: { oidc: { name: 'Kestrel ID' }, github: true, passkey: true },
      session: null,
    })
  })

  it('registers the first passkey with a setup code and signs in', async () => {
    const w = setup()
    await enroll(w)
    const session = await w.b.session()
    expect(session.session).toMatchObject({ subject: 'admin', method: 'passkey' })
    expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
    expect(w.repos.auth.passkeys.list().map((p) => p.name)).toEqual(['MacBook'])
  })

  it('sets the session cookie HttpOnly, Secure, SameSite=Lax with the __Host- prefix', async () => {
    const w = setup()
    const authenticator = await enroll(w)
    const res = await passkeyLogin(w, authenticator)
    const cookie = res.setCookies.find((line) => line.startsWith(`${COOKIE}=`))
    expect(cookie).toBeDefined()
    expect(cookie).toMatch(/; HttpOnly/)
    expect(cookie).toMatch(/; Secure/)
    expect(cookie).toMatch(/; SameSite=Lax/)
    expect(cookie).toMatch(/; Path=\//)
    expect(cookie).not.toMatch(/Domain=/i)
  })

  it('uses a plain cookie name without Secure on an http public URL', async () => {
    const w = setup({
      config: authConfig({
        publicOrigin: 'http://localhost:3000',
        secure: false,
        rpId: 'localhost',
      }),
    })
    const authenticator = createSoftAuthenticator({ origin: 'http://localhost:3000' })
    const { code } = issueSetupCode(w.repos.settings, currentTime())
    const verify = await w.b.call('POST', '/api/auth/setup/verify', {
      body: { code },
      origin: 'http://localhost:3000',
    })
    const { enrollmentId, options } = setupCodeResponseSchema.parse(verify.json)
    const res = await w.b.call('POST', '/api/auth/setup/register', {
      body: { enrollmentId, name: 'dev box', credential: authenticator.register(options) },
      origin: 'http://localhost:3000',
    })
    expect(res.status).toBe(204)
    const cookie = res.setCookies.find((line) => line.startsWith('hinomi_session='))
    expect(cookie).toBeDefined()
    expect(cookie).not.toMatch(/Secure/)
  })

  it('stores only the hash of the session token', async () => {
    const w = setup()
    await enroll(w)
    const token = w.b.jar.get(COOKIE) as string
    const rows = w.repos.auth.sessions.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).not.toBe(token)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  describe('setup codes', () => {
    it('work once', async () => {
      const w = setup()
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      expect((await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })).status).toBe(
        200,
      )
      expect((await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })).status).toBe(
        401,
      )
    })

    it('accept lower case and missing dashes', async () => {
      const w = setup()
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      const typed = code.replaceAll('-', '').toLowerCase()
      expect(
        (await w.b.call('POST', '/api/auth/setup/verify', { body: { code: typed } })).status,
      ).toBe(200)
    })

    it('expire after 15 minutes', async () => {
      const w = setup()
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      w.clock.now += 15 * 60 * 1000
      expect((await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })).status).toBe(
        401,
      )
    })

    it('lock out after five wrong codes, even for the right one', async () => {
      const w = setup()
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      for (let i = 0; i < 5; i++) {
        const res = await w.b.call('POST', '/api/auth/setup/verify', {
          body: { code: 'AAAA-BBBB-CCCC' },
        })
        expect(res.status).toBe(401)
      }
      expect(
        (await w.b.call('POST', '/api/auth/setup/verify', { body: { code: 'AAAA-BBBB-CCCC' } }))
          .status,
      ).toBe(401)
      const locked = await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })
      expect(locked.status).toBe(429)
      expect(locked.json).toMatchObject({ error: { code: 'rate_limited' } })
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
      // The lock is on the guessing client only: the operator elsewhere is not locked out.
      const operator = browser(w.app, '192.0.2.10')
      expect(
        (await operator.call('POST', '/api/auth/setup/verify', { body: { code } })).status,
      ).toBe(200)
    })

    it('a code issued after a lockout can be redeemed at once', async () => {
      const w = setup()
      issueSetupCode(w.repos.settings, new Date(w.clock.now))
      for (let i = 0; i < 8; i++) {
        await w.b.call('POST', '/api/auth/setup/verify', { body: { code: 'AAAA-BBBB-CCCC' } })
      }
      expect(
        (await w.b.call('POST', '/api/auth/setup/verify', { body: { code: 'AAAA-BBBB-CCCC' } }))
          .status,
      ).toBe(429)
      // The operator runs setup-code again and types it in from their own browser.
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      const operator = browser(w.app, '192.0.2.10')
      expect(
        (await operator.call('POST', '/api/auth/setup/verify', { body: { code } })).status,
      ).toBe(200)
    })

    it('guesses from rotating IPv6 addresses lock their /64, never the operator', async () => {
      const w = setup()
      const operator = browser(w.app, '192.0.2.10')
      let guesses = 0
      const guess = () => {
        guesses++
        // A fresh address in the same /64 for every guess.
        return browser(w.app, `2001:db8:aa:bb::${guesses.toString(16)}`).call(
          'POST',
          '/api/auth/setup/verify',
          { body: { code: 'AAAA-BBBB-CCCC' } },
        )
      }
      const rounds: number[][] = []
      for (let round = 0; round < 3; round++) {
        const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
        const statuses: number[] = []
        for (let i = 0; i < 8; i++) statuses.push((await guess()).status)
        rounds.push(statuses)
        w.clock.now += 500
        const res = await operator.call('POST', '/api/auth/setup/verify', { body: { code } })
        expect(res.status).toBe(200)
      }
      // The /64 counts as one client: five failures, then it waits, round after round.
      expect(rounds[0]?.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
      expect(rounds.map((statuses) => statuses.at(-1))).toEqual([429, 429, 429])
    })

    it('register only with the enrollment they started', async () => {
      const w = setup()
      const authenticator = createSoftAuthenticator({ origin: ORIGIN })
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      const { options } = setupCodeResponseSchema.parse(
        (await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })).json,
      )
      const res = await w.b.call('POST', '/api/auth/setup/register', {
        body: {
          enrollmentId: 'not-the-one',
          name: 'x',
          credential: authenticator.register(options),
        },
      })
      expect(res.status).toBe(401)
      expect(w.repos.auth.passkeys.count()).toBe(0)
    })
  })

  describe('CSRF and origin', () => {
    it('refuses a change without the CSRF token, or with a wrong one', async () => {
      const w = setup()
      await enroll(w)
      const missing = await w.b.call('PATCH', '/api/settings', {
        body: { osvEnabled: false },
        sendCsrf: false,
      })
      expect(missing.status).toBe(403)
      expect(missing.json).toMatchObject({ error: { code: 'forbidden' } })
      const wrong = await w.b.call('PATCH', '/api/settings', {
        body: { osvEnabled: false },
        sendCsrf: false,
        headers: { 'x-hinomi-csrf': 'nope' },
      })
      expect(wrong.status).toBe(403)
      expect(
        (await w.b.call('PATCH', '/api/settings', { body: { osvEnabled: false } })).status,
      ).toBe(200)
    })

    it('refuses a change from another origin even with the token', async () => {
      const w = setup()
      await enroll(w)
      const res = await w.b.call('PATCH', '/api/settings', {
        body: { osvEnabled: false },
        origin: 'https://evil.example.dev',
      })
      expect(res.status).toBe(403)
      const site = await w.b.call('PATCH', '/api/settings', {
        body: { osvEnabled: false },
        origin: null,
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(site.status).toBe(403)
    })

    it('refuses a login post from another origin', async () => {
      const w = setup()
      const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
      const res = await w.b.call('POST', '/api/auth/setup/verify', {
        body: { code },
        origin: 'https://evil.example.dev',
      })
      expect(res.status).toBe(403)
    })
  })

  describe('sessions', () => {
    it('logout ends the session on the server', async () => {
      const w = setup()
      await enroll(w)
      const stolen = w.b.jar.get(COOKIE) as string
      expect((await w.b.call('POST', '/api/auth/logout')).status).toBe(204)
      expect(w.b.jar.has(COOKIE)).toBe(false)
      expect(w.repos.auth.sessions.list()).toEqual([])
      const replay = await w.app.request('/api/overview', {
        headers: { cookie: `${COOKIE}=${stolen}` },
      })
      expect(replay.status).toBe(401)
    })

    it('rotates the token on every login', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      const first = w.b.jar.get(COOKIE) as string
      expect((await passkeyLogin(w, authenticator)).status).toBe(204)
      const second = w.b.jar.get(COOKIE) as string
      expect(second).not.toBe(first)
      const old = await w.app.request('/api/overview', {
        headers: { cookie: `${COOKIE}=${first}` },
      })
      expect(old.status).toBe(401)
      expect(w.repos.auth.sessions.list()).toHaveLength(1)
    })

    it('ends after 12 idle hours', async () => {
      const w = setup()
      await enroll(w)
      w.clock.now += SESSION_IDLE_MS - 60_000
      expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
      w.clock.now += SESSION_IDLE_MS - 60_000
      expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
      w.clock.now += SESSION_IDLE_MS
      expect((await w.b.call('GET', '/api/overview')).status).toBe(401)
      expect(w.repos.auth.sessions.list()).toEqual([])
    })

    it('ends after 7 days however busy', async () => {
      const w = setup()
      await enroll(w)
      const start = w.clock.now
      while (w.clock.now - start < SESSION_ABSOLUTE_MS - 2 * 60 * 60 * 1000) {
        w.clock.now += 60 * 60 * 1000
        expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
      }
      w.clock.now = start + SESSION_ABSOLUTE_MS
      expect((await w.b.call('GET', '/api/overview')).status).toBe(401)
    })

    it('lists sessions and revokes the others', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      const other = browser(w.app)
      expect((await passkeyLogin(w, authenticator, other)).status).toBe(204)
      const list = authSessionsResponseSchema.parse(
        (await w.b.call('GET', '/api/auth/sessions')).json,
      )
      expect(list.sessions.map((s) => s.current).sort()).toEqual([false, true])
      expect((await w.b.call('POST', '/api/auth/sessions/revoke-others')).status).toBe(204)
      expect((await other.call('GET', '/api/overview')).status).toBe(401)
      expect((await w.b.call('GET', '/api/overview')).status).toBe(200)
    })

    it('revokes one session by its public id', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      const other = browser(w.app)
      await passkeyLogin(w, authenticator, other)
      const list = authSessionsResponseSchema.parse(
        (await w.b.call('GET', '/api/auth/sessions')).json,
      )
      const target = list.sessions.find((s) => !s.current)?.id as string
      expect((await w.b.call('DELETE', `/api/auth/sessions/${target}`)).status).toBe(204)
      expect((await other.call('GET', '/api/overview')).status).toBe(401)
    })
  })

  describe('passkeys', () => {
    it('sign in with a passkey', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      await w.b.call('POST', '/api/auth/logout')
      expect((await passkeyLogin(w, authenticator)).status).toBe(204)
      expect((await w.b.session()).session?.subject).toBe('admin')
    })

    it('refuse a forged signature, a replayed challenge, another origin and another rp', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      const forger = createSoftAuthenticator({ origin: ORIGIN })
      const fresh = browser(w.app)
      expect(
        (await passkeyLogin(w, authenticator, fresh, { signWith: forger.privateKey })).status,
      ).toBe(401)
      expect(
        (await passkeyLogin(w, authenticator, fresh, { origin: 'https://evil.example.dev' }))
          .status,
      ).toBe(401)
      expect(
        (await passkeyLogin(w, authenticator, fresh, { rpId: 'evil.example.dev' })).status,
      ).toBe(401)
      expect((await passkeyLogin(w, authenticator, fresh, { flags: 0x01 })).status).toBe(401)

      const options = passkeyRequestOptionsSchema.parse(
        (await fresh.call('POST', '/api/auth/passkey/login/options')).json,
      )
      const credential = authenticator.assert(options)
      expect(
        (await fresh.call('POST', '/api/auth/passkey/login', { body: { credential } })).status,
      ).toBe(204)
      const replay = browser(w.app)
      expect(
        (await replay.call('POST', '/api/auth/passkey/login', { body: { credential } })).status,
      ).toBe(401)
    })

    it('refuse a signature counter that goes back', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      expect((await passkeyLogin(w, authenticator, w.b, { signCount: 10 })).status).toBe(204)
      expect((await passkeyLogin(w, authenticator, browser(w.app), { signCount: 9 })).status).toBe(
        401,
      )
    })

    it('audit failed logins without secrets', async () => {
      const w = setup()
      const authenticator = await enroll(w)
      const forger = createSoftAuthenticator({ origin: ORIGIN })
      await passkeyLogin(w, authenticator, browser(w.app), { signWith: forger.privateKey })
      const audit = auditResponseSchema.parse((await w.b.call('GET', '/api/audit')).json)
      expect(audit.events[0]).toMatchObject({
        action: 'login_failed',
        actor: 'admin',
        detail: 'passkey: bad signature',
      })
    })

    it('add another passkey while signed in, and remove one with its sessions', async () => {
      const w = setup({ config: authConfig({ oidc: null, github: null, allowed: [] }) })
      await enroll(w)
      // The only way in cannot be removed.
      const only = w.repos.auth.passkeys.list()[0]?.id as number
      expect((await w.b.call('DELETE', `/api/auth/passkeys/${only}`)).status).toBe(409)

      const second = createSoftAuthenticator({ origin: ORIGIN })
      const options = passkeyCreationOptionsSchema.parse(
        (await w.b.call('POST', '/api/auth/passkeys/options')).json,
      )
      expect(options.excludeCredentials).toHaveLength(1)
      const added = await w.b.call('POST', '/api/auth/passkeys', {
        body: { name: 'YubiKey', credential: second.register(options) },
      })
      expect(added.status).toBe(204)
      const list = passkeysResponseSchema.parse((await w.b.call('GET', '/api/auth/passkeys')).json)
      expect(list.passkeys.map((p) => p.name)).toEqual(['MacBook', 'YubiKey'])

      // Removing the passkey this session started with ends the session.
      expect((await w.b.call('DELETE', `/api/auth/passkeys/${only}`)).status).toBe(204)
      expect((await w.b.call('GET', '/api/overview')).status).toBe(401)
    })

    it('a registration challenge of one session cannot be used by another', async () => {
      const w = setup()
      await enroll(w)
      const authenticator = createSoftAuthenticator({ origin: ORIGIN })
      const options = passkeyCreationOptionsSchema.parse(
        (await w.b.call('POST', '/api/auth/passkeys/options')).json,
      )
      const other = browser(w.app)
      await enroll(w, other, 'Phone')
      const res = await other.call('POST', '/api/auth/passkeys', {
        body: { name: 'stolen', credential: authenticator.register(options) },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('OpenID Connect', () => {
    async function oidcLogin(w: World, idp: FakeIdp, next = '/alerts') {
      const start = await w.b.call('GET', `/api/auth/oidc/start?next=${encodeURIComponent(next)}`)
      expect(start.status).toBe(302)
      const location = start.headers.get('location') as string
      const state = recordAuthorization(idp, location)
      return w.b.call('GET', `/api/auth/oidc/callback?code=${state}&state=${state}`)
    }

    it('redirects with PKCE, state and nonce, then signs in an allowed email', async () => {
      const w = setup()
      const start = await w.b.call('GET', '/api/auth/oidc/start?next=/alerts')
      const location = new URL(start.headers.get('location') as string)
      expect(location.origin + location.pathname).toBe('https://id.example.dev/authorize')
      expect(Object.fromEntries(location.searchParams)).toMatchObject({
        response_type: 'code',
        client_id: IDP_CLIENT_ID,
        redirect_uri: `${ORIGIN}/api/auth/oidc/callback`,
        scope: 'openid email profile',
        code_challenge_method: 'S256',
      })
      expect(location.searchParams.get('state')).toMatch(/^[\w-]{40,}$/)
      expect(location.searchParams.get('nonce')).toMatch(/^[\w-]{40,}$/)
      const state = recordAuthorization(w.idp, location.href)
      const back = await w.b.call('GET', `/api/auth/oidc/callback?code=${state}&state=${state}`)
      expect(back.status).toBe(302)
      expect(back.headers.get('location')).toBe('/alerts')
      expect((await w.b.session()).session).toMatchObject({
        subject: 'ops@example.dev',
        method: 'oidc',
      })
    })

    it('refuses an email outside the allow list', async () => {
      const w = setup()
      w.idp.claims = { email: 'intruder@example.dev' }
      const back = await oidcLogin(w, w.idp)
      expect(back.headers.get('location')).toBe('/login?error=not_allowed')
      expect((await w.b.session()).session).toBeNull()
    })

    it('refuses an unverified email', async () => {
      const w = setup()
      w.idp.claims = { email_verified: false }
      expect((await oidcLogin(w, w.idp)).headers.get('location')).toBe('/login?error=not_allowed')
    })

    const tampers: [string, (idp: FakeIdp) => void][] = [
      [
        'signed by another key',
        (idp) => (idp.forgeWith = createSoftAuthenticator({ origin: ORIGIN }).privateKey),
      ],
      ['for another client', (idp) => (idp.claims = { aud: 'someone-else' })],
      ['with another nonce', (idp) => (idp.claims = { nonce: 'replayed' })],
      ['from another issuer', (idp) => (idp.claims = { iss: 'https://evil.example.dev' })],
      ['expired', (idp) => (idp.claims = { exp: Math.floor(nowMs() / 1000) - 3600 })],
    ]
    it.each(tampers)('refuses an ID token %s', async (_name, tamper) => {
      const w = setup()
      tamper(w.idp)
      expect((await oidcLogin(w, w.idp)).headers.get('location')).toBe('/login?error=failed')
      expect((await w.b.session()).session).toBeNull()
    })

    it('refuses a callback without the flow cookie, with another state, or replayed', async () => {
      const w = setup()
      const start = await w.b.call('GET', '/api/auth/oidc/start')
      const state = recordAuthorization(w.idp, start.headers.get('location') as string)
      const stranger = browser(w.app)
      const noCookie = await stranger.call(
        'GET',
        `/api/auth/oidc/callback?code=${state}&state=${state}`,
      )
      expect(noCookie.headers.get('location')).toBe('/login?error=expired')
      const tampered = await w.b.call('GET', `/api/auth/oidc/callback?code=${state}&state=other`)
      expect(tampered.headers.get('location')).toBe('/login?error=expired')
      // The flow was spent by the tampered attempt.
      const replay = await w.b.call('GET', `/api/auth/oidc/callback?code=${state}&state=${state}`)
      expect(replay.headers.get('location')).toBe('/login?error=expired')
    })

    it('never redirects off site after login', async () => {
      const w = setup()
      for (const next of [
        '//evil.example.dev',
        '/\\evil.example.dev',
        'https://evil.example.dev',
        '/api/audit',
      ]) {
        const back = await oidcLogin(w, w.idp, next)
        expect(back.headers.get('location')).toBe('/')
      }
    })
  })

  describe('GitHub', () => {
    it('signs in an allowed login and refuses others', async () => {
      const w = setup()
      const start = await w.b.call('GET', '/api/auth/github/start')
      const location = new URL(start.headers.get('location') as string)
      expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
      expect(location.searchParams.get('scope')).toBe('read:user user:email')
      const state = recordAuthorization(w.idp, location.href)
      const back = await w.b.call('GET', `/api/auth/github/callback?code=${state}&state=${state}`)
      expect(back.headers.get('location')).toBe('/')
      expect((await w.b.session()).session).toMatchObject({
        subject: 'github:id:583231',
        method: 'github',
      })

      const other = browser(w.app)
      w.idp.github = {
        login: 'someone',
        id: 9001,
        emails: [{ email: 'ops@example.dev', verified: false, primary: true }],
      }
      const start2 = await other.call('GET', '/api/auth/github/start')
      const state2 = recordAuthorization(w.idp, start2.headers.get('location') as string)
      const refused = await other.call(
        'GET',
        `/api/auth/github/callback?code=${state2}&state=${state2}`,
      )
      expect(refused.headers.get('location')).toBe('/login?error=not_allowed')
    })
  })

  describe('GitHub account ids', () => {
    async function githubLogin(w: World, b = w.b) {
      const start = await b.call('GET', '/api/auth/github/start')
      const state = recordAuthorization(w.idp, start.headers.get('location') as string)
      return b.call('GET', `/api/auth/github/callback?code=${state}&state=${state}`)
    }

    it('pins a github:<login> rule to the first account id and refuses a reclaimed login', async () => {
      const w = setup({ config: authConfig({ allowed: parseAllowRules('github:kestrel-ops') }) })
      expect((await githubLogin(w)).headers.get('location')).toBe('/')
      expect(w.repos.settings.get('auth.githubPins', z.record(z.string(), z.string()))).toEqual({
        'kestrel-ops': '583231',
      })
      // The owner renames the account; someone else registers the old login.
      w.idp.github = {
        login: 'kestrel-ops',
        id: 7777,
        emails: [{ email: 'squatter@example.net', verified: true, primary: true }],
      }
      const other = browser(w.app)
      expect((await githubLogin(w, other)).headers.get('location')).toBe('/login?error=not_allowed')
      const audit = auditResponseSchema.parse((await w.b.call('GET', '/api/audit')).json)
      expect(audit.events[0]).toMatchObject({
        action: 'login_failed',
        actor: 'github:kestrel-ops (id 7777)',
        detail: 'github: the login kestrel-ops is pinned to another account id',
      })
      // A login rule names a login: after a rename the account needs github:id:<n> or the new name.
      w.idp.github = { login: 'kestrel-renamed', id: 583231, emails: [] }
      expect((await githubLogin(w, browser(w.app))).headers.get('location')).toBe(
        '/login?error=not_allowed',
      )
    })

    it('admits github:id:<n> whatever the login is now', async () => {
      const w = setup({ config: authConfig({ allowed: parseAllowRules('github:id:583231') }) })
      w.idp.github = { login: 'kestrel-renamed', id: 583231, emails: [] }
      expect((await githubLogin(w)).headers.get('location')).toBe('/')
      expect((await w.b.session()).session?.subject).toBe('github:id:583231')
    })

    it('counts only the primary verified email', async () => {
      const w = setup({ config: authConfig({ allowed: parseAllowRules('@example.dev') }) })
      w.idp.github = {
        login: 'someone',
        id: 31337,
        emails: [
          { email: 'someone@example.net', verified: true, primary: true },
          { email: 'someone@example.dev', verified: true, primary: false },
        ],
      }
      expect((await githubLogin(w)).headers.get('location')).toBe('/login?error=not_allowed')
    })
  })

  describe('passkeys registered through a provider', () => {
    async function contractorWithPasskey(w: World) {
      const start = await w.b.call('GET', '/api/auth/github/start')
      const state = recordAuthorization(w.idp, start.headers.get('location') as string)
      await w.b.call('GET', `/api/auth/github/callback?code=${state}&state=${state}`)
      await w.b.session()
      const authenticator = createSoftAuthenticator({ origin: ORIGIN })
      const options = passkeyCreationOptionsSchema.parse(
        (await w.b.call('POST', '/api/auth/passkeys/options')).json,
      )
      const added = await w.b.call('POST', '/api/auth/passkeys', {
        body: { name: 'Contractor laptop', credential: authenticator.register(options) },
      })
      expect(added.status).toBe(204)
      return authenticator
    }

    it('belong to the subject that registered them, not to their name', async () => {
      const w = setup()
      const authenticator = await contractorWithPasskey(w)
      const list = passkeysResponseSchema.parse((await w.b.call('GET', '/api/auth/passkeys')).json)
      expect(
        list.passkeys.map(({ name, owner, ownerMethod }) => ({ name, owner, ownerMethod })),
      ).toEqual([{ name: 'Contractor laptop', owner: 'github:id:583231', ownerMethod: 'github' }])
      const other = browser(w.app)
      expect((await passkeyLogin(w, authenticator, other)).status).toBe(204)
      expect((await other.session()).session).toMatchObject({
        subject: 'github:id:583231',
        method: 'passkey',
      })
      // A passkey added from that passkey session still belongs to the contractor.
      const second = createSoftAuthenticator({ origin: ORIGIN })
      const options = passkeyCreationOptionsSchema.parse(
        (await other.call('POST', '/api/auth/passkeys/options')).json,
      )
      await other.call('POST', '/api/auth/passkeys', {
        body: { name: 'Contractor phone', credential: second.register(options) },
      })
      expect(w.repos.auth.passkeys.list().map((p) => p.ownerSubject)).toEqual([
        'github:id:583231',
        'github:id:583231',
      ])
    })

    it('stop working when the contractor leaves the allow list (at login)', async () => {
      const config = authConfig()
      const w = setup({ config })
      const authenticator = await contractorWithPasskey(w)
      // The operator drops the contractor; this core has not restarted yet.
      config.allowed.splice(0, config.allowed.length, ...parseAllowRules('ops@example.dev'))
      const res = await passkeyLogin(w, authenticator, browser(w.app))
      expect(res.status).toBe(401)
      expect(w.repos.auth.passkeys.list()).toEqual([])
      const kinds = w.repos.audit.list({ limit: 3 }).map((e) => [e.action, e.detail])
      expect(kinds).toEqual([
        ['login_failed', 'passkey: its owner is no longer allowed'],
        ['passkey_removed', 'Contractor laptop: its owner is no longer in HINOMI_AUTH_ALLOWED'],
        expect.any(Array),
      ])
    })

    it('are removed at boot with their sessions when the contractor leaves', async () => {
      const w = setup()
      const authenticator = await contractorWithPasskey(w)
      const other = browser(w.app)
      expect((await passkeyLogin(w, authenticator, other)).status).toBe(204)
      await enroll(w, browser(w.app), 'Admin key')
      createAuthCore({
        config: authConfig({ allowed: parseAllowRules('ops@example.dev') }),
        repositories: w.repos,
      }).startup()
      expect(w.repos.auth.passkeys.list().map((p) => p.name)).toEqual(['Admin key'])
      expect(w.repos.auth.sessions.list().map((s) => s.subject)).toEqual(['admin'])
    })

    it('are removed at boot when their provider is no longer configured', async () => {
      const w = setup()
      await contractorWithPasskey(w)
      createAuthCore({ config: authConfig({ github: null }), repositories: w.repos }).startup()
      expect(w.repos.auth.passkeys.list()).toEqual([])
    })
  })

  it('refuses the login when the audit row cannot be written', async () => {
    const w = setup()
    const authenticator = await enroll(w)
    const original = w.repos.audit.record.bind(w.repos.audit)
    const record = vi.spyOn(w.repos.audit, 'record').mockImplementation((input, at) => {
      if (input.action === 'login') throw new Error('disk full')
      return original(input, at)
    })
    const other = browser(w.app)
    const res = await passkeyLogin(w, authenticator, other)
    expect(res.status).toBe(500)
    expect(res.setCookies.some((line) => line.startsWith(`${COOKIE}=`))).toBe(false)
    expect(w.repos.auth.sessions.list()).toHaveLength(1)
    record.mockRestore()
  })

  it('counts passkey failures against the client, never against the passkey', async () => {
    const w = setup()
    const authenticator = await enroll(w)
    const forger = createSoftAuthenticator({ origin: ORIGIN })
    // Forged assertions from many addresses in one /64, each with its own challenge.
    const statuses: number[] = []
    for (let i = 1; i <= 8; i++) {
      const attacker = browser(w.app, `2001:db8:cc:dd::${i}`)
      const asked = await attacker.call('POST', '/api/auth/passkey/login/options')
      if (asked.status !== 200) {
        statuses.push(asked.status)
        continue
      }
      const options = passkeyRequestOptionsSchema.parse(asked.json)
      const res = await attacker.call('POST', '/api/auth/passkey/login', {
        body: { credential: authenticator.assert(options, { signWith: forger.privateKey }) },
      })
      statuses.push(res.status)
    }
    // The /64 is one client: five failures, then it waits.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses.at(-1)).toBe(429)
    // The owner, from anywhere else, is not locked out of their passkey.
    expect((await passkeyLogin(w, authenticator, browser(w.app, '192.0.2.10'))).status).toBe(204)
  })

  it('caps anonymous starts per address and warns once about an untrusted X-Forwarded-For', async () => {
    const w = setup()
    const flood = browser(w.app, '203.0.113.9')
    const statuses: number[] = []
    // 30 free starts, the 31st starts the doubling lock, so the 32nd waits.
    for (let i = 0; i < 32; i++) {
      statuses.push(
        (
          await flood.call('POST', '/api/auth/passkey/login/options', {
            headers: { 'x-forwarded-for': '10.0.0.1' },
          })
        ).status,
      )
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(31)
    expect(statuses.at(-1)).toBe(429)
    // Another address is not affected.
    expect(
      (await browser(w.app, '198.51.100.7').call('POST', '/api/auth/passkey/login/options')).status,
    ).toBe(200)
    // Rotating through one IPv6 /64 is one client.
    const rotating: number[] = []
    for (let i = 1; i <= 32; i++) {
      const b = browser(w.app, `2001:db8:ee:ff::${i.toString(16)}`)
      rotating.push((await b.call('POST', '/api/auth/passkey/login/options')).status)
    }
    expect(rotating.at(-1)).toBe(429)
    expect(
      (await browser(w.app, '2001:db8:ee:100::1').call('POST', '/api/auth/passkey/login/options'))
        .status,
    ).toBe(200)
    expect(
      w.logger.lines.filter((l) => l.message.includes('X-Forwarded-For came from a peer')),
    ).toHaveLength(1)
  })

  it('anonymous passkey challenges cannot push out a pending setup challenge', async () => {
    const w = setup()
    const authenticator = createSoftAuthenticator({ origin: ORIGIN })
    const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
    const { enrollmentId, options } = setupCodeResponseSchema.parse(
      (await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })).json,
    )
    const flood = browser(w.app)
    for (let i = 0; i < 1100; i++) {
      await flood.call('POST', '/api/auth/passkey/login/options')
    }
    const register = await w.b.call('POST', '/api/auth/setup/register', {
      body: { enrollmentId, name: 'MacBook', credential: authenticator.register(options) },
    })
    expect(register.status).toBe(204)
  }, 30_000)

  it('ends provider sessions at boot when the allow list no longer covers them', async () => {
    const w = setup()
    const start = await w.b.call('GET', '/api/auth/github/start')
    const state = recordAuthorization(w.idp, start.headers.get('location') as string)
    await w.b.call('GET', `/api/auth/github/callback?code=${state}&state=${state}`)
    await enroll(w, browser(w.app))
    expect(w.repos.auth.sessions.list()).toHaveLength(2)
    // A new core on the same repositories stands in for a restart with a new allow list.
    createAuthCore({
      config: authConfig({ allowed: parseAllowRules('ops@example.dev') }),
      repositories: w.repos,
    }).startup()
    expect(w.repos.auth.sessions.list().map((s) => s.method)).toEqual(['passkey'])
  })

  it('removes every session at boot when the login is turned off', async () => {
    const w = setup()
    await enroll(w)
    createAuthCore({ config: null, repositories: w.repos }).startup()
    expect(w.repos.auth.sessions.list()).toEqual([])
  })

  it('writes logins and changes to the audit log with the actor', async () => {
    const w = setup()
    await enroll(w)
    await w.b.call('PATCH', '/api/settings', { body: { osvEnabled: false } })
    const audit = auditResponseSchema.parse((await w.b.call('GET', '/api/audit')).json)
    expect(audit.events.map((e) => [e.action, e.actor, e.httpMethod, e.path, e.detail])).toEqual([
      ['change', 'admin', 'PATCH', '/api/settings', null],
      ['login', 'admin', null, null, 'passkey'],
      ['passkey_added', 'admin', null, null, 'MacBook, with a setup code'],
      ['setup_code_used', null, null, null, null],
    ])
  })

  it('pages the audit log', async () => {
    const w = setup({ config: null })
    for (let i = 0; i < 5; i++) w.repos.audit.record({ action: 'change', path: `/api/x/${i}` })
    const first = auditResponseSchema.parse((await w.b.call('GET', '/api/audit?limit=2')).json)
    expect(first.events.map((e) => e.path)).toEqual(['/api/x/4', '/api/x/3'])
    const second = auditResponseSchema.parse(
      (await w.b.call('GET', `/api/audit?limit=2&before=${first.nextBefore}`)).json,
    )
    expect(second.events.map((e) => e.path)).toEqual(['/api/x/2', '/api/x/1'])
    const last = auditResponseSchema.parse(
      (await w.b.call('GET', `/api/audit?limit=2&before=${second.nextBefore}`)).json,
    )
    expect(last).toMatchObject({ nextBefore: null })
  })

  it('never logs the setup code, the cookie, the CSRF token or a client secret', async () => {
    const w = setup()
    const { code } = issueSetupCode(w.repos.settings, new Date(w.clock.now))
    await w.b.call('POST', '/api/auth/setup/verify', { body: { code: 'WRONG-CODE-0000' } })
    await w.b.call('POST', '/api/auth/setup/verify', { body: { code } })
    await enroll(w)
    w.idp.failToken = true
    const start = await w.b.call('GET', '/api/auth/oidc/start')
    const state = recordAuthorization(w.idp, start.headers.get('location') as string)
    await w.b.call('GET', `/api/auth/oidc/callback?code=${state}&state=${state}`)
    const session = await w.b.session()
    const logged = w.logger.text() + JSON.stringify(w.repos.audit.list({ limit: 100 }))
    for (const secret of [
      code,
      w.b.jar.get(COOKIE) as string,
      session.session?.csrfToken as string,
      IDP_CLIENT_SECRET,
    ]) {
      expect(logged).not.toContain(secret)
    }
  })
})
