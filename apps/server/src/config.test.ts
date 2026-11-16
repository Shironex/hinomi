import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('boots with nothing set', () => {
    const config = loadConfig({})
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3000)
    expect(config.dataDir).toBe(resolve('data'))
    expect(config.databaseFile).toBe(resolve('data', 'hinomi.db'))
    expect(config.secretKey).toBeUndefined()
    expect(config.auth).toBeNull()
  })

  it('defaults the data dir to /data in production', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).dataDir).toBe(resolve('/data'))
  })

  it('reads HINOMI_DATA_DIR and HINOMI_SECRET_KEY', () => {
    const config = loadConfig({
      HINOMI_DATA_DIR: '/srv/hinomi',
      HINOMI_SECRET_KEY: 'a-long-enough-secret',
      PORT: '8080',
    })
    expect(config.databaseFile).toBe(resolve('/srv/hinomi', 'hinomi.db'))
    expect(config.secretKey).toBe('a-long-enough-secret')
    expect(config.port).toBe(8080)
  })

  it('treats empty values as unset', () => {
    const config = loadConfig({ HINOMI_SECRET_KEY: '', PORT: '', HOST: '' })
    expect(config.secretKey).toBeUndefined()
    expect(config.port).toBe(3000)
    expect(config.host).toBe('0.0.0.0')
  })

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT must be an integer/)
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT must be an integer/)
  })

  it('keeps the local runner off unless HINOMI_LOCAL_RUNNER is 1', () => {
    expect(loadConfig({}).localRunner).toMatchObject({ enabled: false, checks: false })
    expect(loadConfig({ HINOMI_LOCAL_RUNNER: '0' }).localRunner.enabled).toBe(false)
    const on = loadConfig({ HINOMI_LOCAL_RUNNER: '1', HINOMI_LOCAL_RUNNER_CHECKS: 'true' })
    expect(on.localRunner).toMatchObject({ enabled: true, checks: true })
    expect(on.localRunner.entry).toMatch(/actions\/fix-runner\/dist\/index\.mjs$/)
    expect(() => loadConfig({ HINOMI_LOCAL_RUNNER: 'maybe' })).toThrow(
      /HINOMI_LOCAL_RUNNER must be 1 or 0/,
    )
  })

  it('reads HINOMI_WEBHOOK_PORT, which must differ from PORT', () => {
    expect(loadConfig({}).webhookPort).toBeNull()
    expect(loadConfig({ HINOMI_WEBHOOK_PORT: '3001' }).webhookPort).toBe(3001)
    expect(() => loadConfig({ HINOMI_WEBHOOK_PORT: '0' })).toThrow(
      /HINOMI_WEBHOOK_PORT must be an integer/,
    )
    expect(() => loadConfig({ HINOMI_WEBHOOK_PORT: '3000' })).toThrow(/must differ from PORT/)
  })

  it('rejects a short secret key without echoing it', () => {
    let message = ''
    try {
      loadConfig({ HINOMI_SECRET_KEY: 'short-secret' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/HINOMI_SECRET_KEY must be at least 16 characters/)
    expect(message).not.toContain('short-secret')
  })

  it('waits 25 seconds for a running scan on shutdown by default', () => {
    expect(loadConfig({}).shutdownTimeoutMs).toBe(25_000)
    expect(loadConfig({ HINOMI_SHUTDOWN_TIMEOUT_SECONDS: '' }).shutdownTimeoutMs).toBe(25_000)
  })

  it('reads HINOMI_SHUTDOWN_TIMEOUT_SECONDS', () => {
    expect(loadConfig({ HINOMI_SHUTDOWN_TIMEOUT_SECONDS: '90' }).shutdownTimeoutMs).toBe(90_000)
    expect(loadConfig({ HINOMI_SHUTDOWN_TIMEOUT_SECONDS: '0' }).shutdownTimeoutMs).toBe(0)
  })

  it('rejects an invalid shutdown timeout', () => {
    for (const value of ['-1', '1.5', 'abc', '3601']) {
      expect(() => loadConfig({ HINOMI_SHUTDOWN_TIMEOUT_SECONDS: value })).toThrow(
        /HINOMI_SHUTDOWN_TIMEOUT_SECONDS must be a whole number/,
      )
    }
  })

  it('trusts no proxy and verifies no Cloudflare Access token by default', () => {
    const config = loadConfig({})
    expect(config.trustedProxies).toEqual([])
    expect(config.cfAccess).toBeNull()
  })

  it('reads HINOMI_TRUSTED_PROXIES as a comma separated list', () => {
    expect(
      loadConfig({ HINOMI_TRUSTED_PROXIES: '172.20.0.0/16, 10.0.0.7,,fd00::/8' }).trustedProxies,
    ).toEqual(['172.20.0.0/16', '10.0.0.7', 'fd00::/8'])
    expect(() => loadConfig({ HINOMI_TRUSTED_PROXIES: '10.0.0.0/8,proxy.example.dev' })).toThrow(
      /HINOMI_TRUSTED_PROXIES: "proxy.example.dev" is not an IP address/,
    )
  })

  it('reads the Cloudflare Access team domain and audience together', () => {
    expect(
      loadConfig({ HINOMI_CF_ACCESS_TEAM_DOMAIN: 'kestrel-co', HINOMI_CF_ACCESS_AUD: 'aud-tag' })
        .cfAccess,
    ).toEqual({ teamDomain: 'https://kestrel-co.cloudflareaccess.com', audience: 'aud-tag' })
    expect(() => loadConfig({ HINOMI_CF_ACCESS_TEAM_DOMAIN: 'kestrel-co' })).toThrow(/set both/)
    expect(() => loadConfig({ HINOMI_CF_ACCESS_AUD: 'aud-tag' })).toThrow(/set both/)
    expect(() =>
      loadConfig({
        HINOMI_CF_ACCESS_TEAM_DOMAIN: 'http://kestrel-co.example.dev',
        HINOMI_CF_ACCESS_AUD: 'a',
      }),
    ).toThrow(/HINOMI_CF_ACCESS_TEAM_DOMAIN must be/)
  })

  describe('built in login', () => {
    const on = { HINOMI_AUTH: '1', HINOMI_AUTH_PUBLIC_URL: 'https://hinomi.example.dev/' }

    it('stays off by default, and off on purpose with HINOMI_AUTH=0', () => {
      expect(loadConfig({}).auth).toBeNull()
      expect(
        loadConfig({ HINOMI_AUTH: '0', HINOMI_AUTH_PUBLIC_URL: 'https://x.example.dev' }).auth,
      ).toBeNull()
    })

    it('refuses to start with login settings but no HINOMI_AUTH (fails closed)', () => {
      expect(() =>
        loadConfig({
          HINOMI_AUTH_PUBLIC_URL: 'https://hinomi.example.dev',
          HINOMI_AUTH_ALLOWED: 'ops@example.dev',
        }),
      ).toThrow(
        'Invalid configuration: HINOMI_AUTH_ALLOWED, HINOMI_AUTH_PUBLIC_URL are set but HINOMI_AUTH is not, so the login would be off. Set HINOMI_AUTH=1 to turn it on, or HINOMI_AUTH=0 to keep it off on purpose',
      )
      expect(() =>
        loadConfig({ HINOMI_AUTH: '', HINOMI_AUTH_PUBLIC_URL: 'https://hinomi.example.dev' }),
      ).toThrow(/HINOMI_AUTH_PUBLIC_URL is set but HINOMI_AUTH is not/)
    })

    it('refuses an http public URL off this machine unless HINOMI_AUTH_ALLOW_HTTP=1', () => {
      expect(() =>
        loadConfig({ ...on, HINOMI_AUTH_PUBLIC_URL: 'http://hinomi.example.dev' }),
      ).toThrow(/HINOMI_AUTH_PUBLIC_URL is http on a host other than localhost/)
      for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
        expect(loadConfig({ ...on, HINOMI_AUTH_PUBLIC_URL: local }).auth?.secure).toBe(false)
      }
      expect(
        loadConfig({
          ...on,
          HINOMI_AUTH_PUBLIC_URL: 'http://hinomi.example.dev',
          HINOMI_AUTH_ALLOW_HTTP: '1',
        }).auth,
      ).toMatchObject({ secure: false, rpId: 'hinomi.example.dev' })
    })

    it('reads the token origin of an OpenID Connect provider such as Google', () => {
      const env = {
        ...on,
        HINOMI_AUTH_OIDC_ISSUER: 'https://accounts.google.com',
        HINOMI_AUTH_OIDC_CLIENT_ID: 'a',
        HINOMI_AUTH_OIDC_CLIENT_SECRET: 'b',
        HINOMI_AUTH_ALLOWED: 'ops@example.dev',
      }
      expect(
        loadConfig({ ...env, HINOMI_AUTH_OIDC_TOKEN_ORIGIN: 'https://oauth2.googleapis.com/' }).auth
          ?.oidc?.tokenOrigin,
      ).toBe('https://oauth2.googleapis.com')
      expect(() =>
        loadConfig({ ...env, HINOMI_AUTH_OIDC_TOKEN_ORIGIN: 'http://oauth2.googleapis.com' }),
      ).toThrow(/HINOMI_AUTH_OIDC_TOKEN_ORIGIN must be an https origin/)
    })

    it('turns on with passkeys only', () => {
      expect(loadConfig(on).auth).toEqual({
        publicOrigin: 'https://hinomi.example.dev',
        secure: true,
        rpId: 'hinomi.example.dev',
        oidc: null,
        github: null,
        allowed: [],
      })
    })

    it('needs the public URL', () => {
      expect(() => loadConfig({ HINOMI_AUTH: '1' })).toThrow(/needs HINOMI_AUTH_PUBLIC_URL/)
      expect(() =>
        loadConfig({ ...on, HINOMI_AUTH_PUBLIC_URL: 'https://x.example.dev/hinomi' }),
      ).toThrow(/HINOMI_AUTH_PUBLIC_URL must be/)
    })

    it('marks an http public URL as not secure', () => {
      const auth = loadConfig({ ...on, HINOMI_AUTH_PUBLIC_URL: 'http://localhost:3000' }).auth
      expect(auth).toMatchObject({
        secure: false,
        rpId: 'localhost',
        publicOrigin: 'http://localhost:3000',
      })
    })

    it('reads OpenID Connect and GitHub with an allow list', () => {
      const auth = loadConfig({
        ...on,
        HINOMI_AUTH_OIDC_ISSUER: 'https://id.example.dev/application/o/hinomi/',
        HINOMI_AUTH_OIDC_CLIENT_ID: 'hinomi',
        HINOMI_AUTH_OIDC_CLIENT_SECRET: 'fictional-secret',
        HINOMI_AUTH_OIDC_NAME: 'Kestrel ID',
        HINOMI_AUTH_GITHUB_CLIENT_ID: 'gh',
        HINOMI_AUTH_GITHUB_CLIENT_SECRET: 'gh-fictional',
        HINOMI_AUTH_ALLOWED: 'ops@example.dev,github:kestrel-ops',
      }).auth
      expect(auth?.oidc).toEqual({
        issuer: 'https://id.example.dev/application/o/hinomi',
        clientId: 'hinomi',
        clientSecret: 'fictional-secret',
        name: 'Kestrel ID',
        tokenOrigin: null,
      })
      expect(auth?.github).toEqual({ clientId: 'gh', clientSecret: 'gh-fictional' })
      expect(auth?.allowed).toHaveLength(2)
    })

    it('refuses a provider without an allow list, so not every account there gets in', () => {
      expect(() =>
        loadConfig({
          ...on,
          HINOMI_AUTH_GITHUB_CLIENT_ID: 'gh',
          HINOMI_AUTH_GITHUB_CLIENT_SECRET: 'x',
        }),
      ).toThrow(/needs HINOMI_AUTH_ALLOWED/)
    })

    it('refuses half a provider and a bad allow entry, without echoing secrets', () => {
      expect(() => loadConfig({ ...on, HINOMI_AUTH_OIDC_CLIENT_SECRET: 'do-not-echo' })).toThrow(
        /together, or none of them/,
      )
      const thrown = (() => {
        try {
          loadConfig({ ...on, HINOMI_AUTH_GITHUB_CLIENT_SECRET: 'do-not-echo' })
          return ''
        } catch (error) {
          return String(error)
        }
      })()
      expect(thrown).toMatch(/together, or neither/)
      expect(thrown).not.toContain('do-not-echo')
      expect(() => loadConfig({ ...on, HINOMI_AUTH_ALLOWED: 'everyone' })).toThrow(
        /HINOMI_AUTH_ALLOWED/,
      )
    })

    it('refuses an http issuer unless it is on this machine', () => {
      expect(() =>
        loadConfig({
          ...on,
          HINOMI_AUTH_OIDC_ISSUER: 'http://id.example.dev',
          HINOMI_AUTH_OIDC_CLIENT_ID: 'a',
          HINOMI_AUTH_OIDC_CLIENT_SECRET: 'b',
          HINOMI_AUTH_ALLOWED: 'ops@example.dev',
        }),
      ).toThrow(/HINOMI_AUTH_OIDC_ISSUER must be/)
    })
  })
})
