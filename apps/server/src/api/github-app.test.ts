import { generateKeyPairSync } from 'node:crypto'
import { sourceSchema } from '@hinomi/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { sources } from '../db/schema.js'
import { createTestApi } from './testing.js'

// GitHub App sources through the API. The key is generated for this run and never committed.
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const KEY_BODY = PRIVATE_KEY.split('\n')[1] ?? ''
const TOKEN = 'ghp_fictionalTokenValue0000000000000000'

const APP = { appId: '1234', installationId: '4242', privateKey: PRIVATE_KEY }

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

async function createApp(call: ReturnType<typeof createTestApi>['call']) {
  const res = await call('POST', '/sources', {
    kind: 'github',
    name: 'kestrel-co',
    auth: 'github_app',
    ...APP,
  })
  expect(res.status).toBe(201)
  return sourceSchema.parse(res.json)
}

describe('github app sources', () => {
  it('stores the private key encrypted and only says it is set', async () => {
    const { call, repos, logger } = createTestApi()
    const source = await createApp(call)
    expect(source).toMatchObject({
      kind: 'github',
      auth: 'github_app',
      appId: '1234',
      installationId: '4242',
      hasToken: true,
    })
    expect(repos.sources.getToken(source.id)).toBe(PRIVATE_KEY.trim())

    const raw =
      repos.db
        .select({ secret: sources.tokenEncrypted })
        .from(sources)
        .where(eq(sources.id, source.id))
        .get()?.secret ?? ''
    expect(raw).toMatch(/^v1\./)
    expect(raw).not.toContain(KEY_BODY)

    for (const path of ['/sources', `/sources/${source.id}`, '/overview']) {
      const res = await call('GET', path)
      expect(res.text).not.toContain(KEY_BODY)
      expect(res.text).not.toContain('PRIVATE KEY')
    }
    expect(logger.text()).not.toContain(KEY_BODY)
  })

  it('reads old sources as token sources', async () => {
    const { call } = createTestApi()
    const res = await call('POST', '/sources', { kind: 'github', name: 'gh', token: TOKEN })
    expect(res.json).toMatchObject({ auth: 'token', appId: null, installationId: null })
  })

  it('checks the fields each way of signing in needs', async () => {
    const { call } = createTestApi()
    const base = { kind: 'github', name: 'gh', auth: 'github_app' }
    const missing = await call('POST', '/sources', {
      ...base,
      appId: '1234',
      privateKey: PRIVATE_KEY,
    })
    expect(missing.status).toBe(400)

    const withToken = await call('POST', '/sources', { ...base, ...APP, token: TOKEN })
    expect(withToken.status).toBe(400)
    expect(withToken.text).not.toContain(KEY_BODY)

    const appFieldsOnToken = await call('POST', '/sources', {
      kind: 'github',
      name: 'gh',
      token: TOKEN,
      appId: '1234',
    })
    expect(appFieldsOnToken.status).toBe(400)

    const coolify = await call('POST', '/sources', {
      kind: 'coolify',
      name: 'main',
      baseUrl: 'https://coolify.example.dev',
      auth: 'github_app',
      ...APP,
    })
    expect(coolify.status).toBe(400)

    const unreadable = await call('POST', '/sources', {
      ...base,
      ...APP,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nbm90LWEta2V5\n-----END RSA PRIVATE KEY-----',
    })
    expect(unreadable.status).toBe(400)
    expect(errorOf(unreadable.json).message).toMatch(/could not be read/)
    expect(unreadable.text).not.toContain('bm90LWEta2V5')

    const notPem = await call('POST', '/sources', { ...base, ...APP, privateKey: 'hello' })
    expect(notPem.status).toBe(400)
    expect(notPem.text).not.toContain('hello')
  })

  it('switches between a token and an app only with the new secret', async () => {
    const { call, repos } = createTestApi()
    const created = await call('POST', '/sources', { kind: 'github', name: 'gh', token: TOKEN })
    const id = (created.json as { id: number }).id

    const noKey = await call('PATCH', `/sources/${id}`, {
      auth: 'github_app',
      appId: '1234',
      installationId: '4242',
    })
    expect(noKey.status).toBe(400)

    const toApp = await call('PATCH', `/sources/${id}`, { auth: 'github_app', ...APP })
    expect(toApp.status).toBe(200)
    expect(toApp.json).toMatchObject({ auth: 'github_app', appId: '1234', installationId: '4242' })
    expect(repos.sources.getToken(id)).toBe(PRIVATE_KEY.trim())

    const moved = await call('PATCH', `/sources/${id}`, { installationId: '5151' })
    expect(moved.json).toMatchObject({ auth: 'github_app', installationId: '5151' })
    expect(repos.sources.getToken(id)).toBe(PRIVATE_KEY.trim())

    const tokenOnApp = await call('PATCH', `/sources/${id}`, { token: TOKEN })
    expect(tokenOnApp.status).toBe(400)

    const noToken = await call('PATCH', `/sources/${id}`, { auth: 'token' })
    expect(noToken.status).toBe(400)

    const back = await call('PATCH', `/sources/${id}`, { auth: 'token', token: TOKEN })
    expect(back.json).toMatchObject({ auth: 'token', appId: null, installationId: null })
    expect(repos.sources.getToken(id)).toBe(TOKEN)
  })

  it('tests app credentials before and after saving them', async () => {
    const { call, testers } = createTestApi()
    const unsaved = await call('POST', '/sources/test', {
      kind: 'github',
      auth: 'github_app',
      ...APP,
    })
    expect(unsaved.json).toMatchObject({ ok: true, account: 'kestrel-co', repoCount: 3 })
    expect(testers.githubApp).toHaveBeenCalledWith({
      baseUrl: null,
      ...APP,
      privateKey: PRIVATE_KEY.trim(),
    })
    expect(testers.github).not.toHaveBeenCalled()

    const source = await createApp(call)
    testers.githubApp.mockClear()
    const saved = await call('POST', `/sources/${source.id}/test`)
    expect(saved.json).toMatchObject({ ok: true })
    expect(testers.githubApp).toHaveBeenCalledWith({
      baseUrl: null,
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY.trim(),
    })
    expect(saved.text).not.toContain(KEY_BODY)
  })
})
