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
})
