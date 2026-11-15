import { registryCredentialSchema, registryCredentialsResponseSchema } from '@hinomi/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { registryCredentials } from '../db/schema.js'
import { createTestApi } from './testing.js'

// Fictional values only.
const SECRET = 'ghp_fictionalRegistryPat000000000000000'
const BASE = '/settings/registry-credentials'

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('registry credentials', () => {
  it('stores the secret encrypted and never returns it', async () => {
    const { call, repos, logger } = createTestApi()
    const created = await call('POST', BASE, {
      host: 'https://GHCR.io/',
      username: 'kestrel-bot',
      secret: SECRET,
    })
    expect(created.status).toBe(201)
    expect(registryCredentialSchema.parse(created.json)).toMatchObject({
      host: 'ghcr.io',
      username: 'kestrel-bot',
      secretSet: true,
    })
    expect(created.text).not.toContain(SECRET)
    expect(created.text).not.toContain('"secret":')

    // At rest: a ciphertext in the secret box format, the plain secret nowhere in the row.
    const row = repos.db
      .select()
      .from(registryCredentials)
      .where(eq(registryCredentials.host, 'ghcr.io'))
      .get()!
    expect(row.secretEncrypted).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(repos.registryCredentials.loginFor('ghcr.io')).toEqual({
      username: 'kestrel-bot',
      secret: SECRET,
    })

    const list = await call('GET', BASE)
    const parsed = registryCredentialsResponseSchema.parse(list.json)
    expect(parsed.canStoreSecrets).toBe(true)
    expect(parsed.items.map((i) => i.host)).toEqual(['ghcr.io'])
    expect(list.text).not.toContain(SECRET)

    const id = (created.json as { id: number }).id
    const patched = await call('PATCH', `${BASE}/${id}`, { secret: `${SECRET}-2` })
    expect(patched.status).toBe(200)
    expect(patched.text).not.toContain(SECRET)
    expect(repos.registryCredentials.loginFor('ghcr.io')?.secret).toBe(`${SECRET}-2`)
    const renamed = await call('PATCH', `${BASE}/${id}`, { username: 'kestrel-ci' })
    expect(renamed.json).toMatchObject({ username: 'kestrel-ci', host: 'ghcr.io' })
    expect(repos.registryCredentials.loginFor('ghcr.io')?.secret).toBe(`${SECRET}-2`)

    expect(logger.text()).not.toContain(SECRET)
  })

  it('keeps one credential per host and never moves a secret to another host', async () => {
    const { call } = createTestApi()
    const first = await call('POST', BASE, {
      host: 'docker.io',
      username: 'kestrel',
      secret: SECRET,
    })
    expect(first.json).toMatchObject({ host: 'registry-1.docker.io' })
    const twice = await call('POST', BASE, {
      host: 'index.docker.io',
      username: 'other',
      secret: SECRET,
    })
    expect(twice.status).toBe(409)
    expect(twice.text).not.toContain(SECRET)

    const id = (first.json as { id: number }).id
    const move = await call('PATCH', `${BASE}/${id}`, { host: 'registry.example.com' })
    expect(move.status).toBe(400)
    expect(errorOf(move.json).code).toBe('validation_failed')
  })

  it('refuses hosts that are not plain hosts without echoing the secret', async () => {
    const { call, logger } = createTestApi()
    for (const host of ['*.example.com', 'http://registry.example.com', 'ghcr.io/kestrel']) {
      const res = await call('POST', BASE, { host, username: 'kestrel', secret: SECRET })
      expect(res.status).toBe(400)
      expect(res.text).not.toContain(SECRET)
    }
    const tooLong = await call('POST', BASE, {
      host: 'ghcr.io',
      username: 'kestrel',
      secret: `${SECRET}${'x'.repeat(5000)}`,
    })
    expect(tooLong.status).toBe(400)
    expect(tooLong.text).not.toContain(SECRET)
    expect(logger.text()).not.toContain(SECRET)
  })

  it('needs HINOMI_SECRET_KEY to store one and says so', async () => {
    const { call } = createTestApi({ withSecret: false })
    const list = await call('GET', BASE)
    expect(registryCredentialsResponseSchema.parse(list.json).canStoreSecrets).toBe(false)
    const res = await call('POST', BASE, { host: 'ghcr.io', username: 'kestrel', secret: SECRET })
    expect(res.status).toBe(400)
    expect(errorOf(res.json).code).toBe('secret_key_missing')
    expect(res.text).not.toContain(SECRET)
  })

  it('removes a credential and answers 404 for unknown ids', async () => {
    const { call, repos } = createTestApi()
    const created = await call('POST', BASE, {
      host: 'registry.example.com:5000',
      username: 'kestrel',
      secret: SECRET,
    })
    const id = (created.json as { id: number }).id
    expect((await call('DELETE', `${BASE}/${id}`)).status).toBe(204)
    expect(repos.registryCredentials.loginFor('registry.example.com:5000')).toBeNull()
    expect((await call('DELETE', `${BASE}/${id}`)).status).toBe(404)
    expect((await call('PATCH', `${BASE}/${id}`, { username: 'x' })).status).toBe(404)
  })
})
