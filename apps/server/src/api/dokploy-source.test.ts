import { describe, expect, it } from 'vitest'
import { dokployRoutes, fakeDokployFetch } from '../sources/dokploy/testing.js'
import { createSourceTesters } from './source-testers.js'
import { createTestApi } from './testing.js'

// Saving and testing a Dokploy source. Every host and key is fictional.

const KEY = 'fictional-dokploy-key-01'
const URL_ = 'https://dokploy.example.dev'

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('a Dokploy source', () => {
  it('needs its URL and its API key', async () => {
    const { call } = createTestApi()
    const noUrl = await call('POST', '/sources', { kind: 'dokploy', name: 'apps', token: KEY })
    expect(noUrl.status).toBe(400)
    expect(errorOf(noUrl.json).message).toBe('A Dokploy source needs its URL')
    const noKey = await call('POST', '/sources', { kind: 'dokploy', name: 'apps', baseUrl: URL_ })
    expect(noKey.status).toBe(400)

    const created = await call('POST', '/sources', {
      kind: 'dokploy',
      name: 'apps',
      baseUrl: URL_,
      token: KEY,
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ kind: 'dokploy', name: 'apps', hasToken: true })
    expect(created.text).not.toContain(KEY)
  })

  it('tests unsaved and saved keys through the Dokploy tester', async () => {
    const { call, testers } = createTestApi()
    const unsaved = await call('POST', '/sources/test', {
      kind: 'dokploy',
      baseUrl: URL_,
      token: KEY,
    })
    expect(unsaved.json).toEqual({ ok: true, message: 'Connected to Dokploy, 2 projects visible' })
    expect(testers.dokploy).toHaveBeenCalledWith({ baseUrl: URL_, token: KEY })

    const noUrl = await call('POST', '/sources/test', { kind: 'dokploy', token: KEY })
    expect(noUrl.status).toBe(400)

    const created = await call('POST', '/sources', {
      kind: 'dokploy',
      name: 'apps',
      baseUrl: URL_,
      token: KEY,
    })
    const id = (created.json as { id: number }).id
    const saved = await call('POST', `/sources/${id}/test`)
    expect(saved.json).toMatchObject({ ok: true })
    expect(testers.dokploy).toHaveBeenLastCalledWith({ baseUrl: URL_, token: KEY })
    expect(saved.text).not.toContain(KEY)
  })
})

describe('the Dokploy tester', () => {
  it('says which version it reached and how many projects the key sees', async () => {
    const { impl } = fakeDokployFetch(dokployRoutes())
    const result = await createSourceTesters({ fetch: impl }).dokploy({ baseUrl: URL_, token: KEY })
    expect(result).toEqual({
      ok: true,
      message: 'Connected to Dokploy v0.25.0, 2 projects visible',
      version: 'v0.25.0',
    })
  })

  it('passes a rejected key on without the key', async () => {
    const { impl } = fakeDokployFetch({ 'project.all': new Response('', { status: 401 }) })
    const result = await createSourceTesters({ fetch: impl }).dokploy({ baseUrl: URL_, token: KEY })
    expect(result).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
