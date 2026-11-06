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
})
