import { describe, expect, it } from 'vitest'
import { createDokployClient, normalizeDokployUrl } from './client.js'
import { DokployError } from './errors.js'
import { fetchDokployInventory, testDokployConnection, withoutCredentials } from './inventory.js'
import { SECRET_MARKER, dokployRoutes, fakeDokployFetch } from './testing.js'

// The Dokploy inventory against recorded fixtures: one project with environments (current
// Dokploy) and one without (older versions). Every name, host and key is fictional.

const KEY = 'fictional-dokploy-key-01'
const BASE = 'https://dokploy.example.dev'

const inventory = (routes: Record<string, string | Response> = dokployRoutes()) => {
  const { impl, asked } = fakeDokployFetch(routes)
  return {
    asked,
    run: () => fetchDokployInventory({ name: 'apps', baseUrl: BASE, token: KEY, fetch: impl }),
  }
}

describe('fetchDokployInventory', () => {
  it('maps applications and compose services to records', async () => {
    const records = await inventory().run()
    const byId = new Map(records.map((r) => [r.externalId, r]))
    expect([...byId.keys()].sort()).toEqual([
      'app-harbor-0001',
      'app-lantern-0003',
      'app-proxy-0002',
      'cmp-docs-0001',
    ])

    expect(byId.get('app-harbor-0001')).toEqual({
      source: 'apps',
      externalId: 'app-harbor-0001',
      name: 'harbor',
      kind: 'application',
      repo: 'kestrel-co/harbor',
      branch: 'main',
      gitRepository: 'kestrel-co/harbor',
      domains: ['https://harbor.example.dev', 'http://api.harbor.example.dev/v1'],
      isPublic: true,
      server: 'edge-1',
      status: 'done',
      image: null,
      lastDeployAt: '2026-11-11T08:00:00.000Z',
      watchPaths: null,
    })

    expect(byId.get('app-proxy-0002')).toMatchObject({
      kind: 'application',
      repo: null,
      branch: null,
      gitRepository: null,
      image: 'ghcr.io/kestrel-co/image-proxy:1.4.0',
      domains: [],
      isPublic: false,
      server: null,
      lastDeployAt: null,
    })

    // A git URL without an owner gives no repo; the URL is kept, without its credentials.
    expect(byId.get('app-lantern-0003')).toMatchObject({
      repo: null,
      branch: 'release',
      gitRepository: 'https://git.example.dev/lantern.git',
      status: 'error',
      server: 'lab-1',
    })

    expect(byId.get('cmp-docs-0001')).toMatchObject({
      kind: 'service',
      repo: 'kestrel-co/docs',
      branch: 'main',
      domains: ['https://docs.example.dev'],
      status: 'done',
      image: null,
    })
  })

  it('claims no container facts, so the stored ones are kept and the guards say unknown', async () => {
    const records = await inventory().run()
    expect(records.every((r) => r.facts === undefined)).toBe(true)
  })

  it('reads per resource routes with GET only and the x-api-key header', async () => {
    const { asked, run } = inventory()
    await run()
    expect(asked.every((a) => a.method === 'GET' && a.apiKey === KEY)).toBe(true)
    expect(asked.map((a) => a.route).sort()).toEqual([
      'application.one?applicationId=app-harbor-0001',
      'application.one?applicationId=app-lantern-0003',
      'application.one?applicationId=app-proxy-0002',
      'compose.one?composeId=cmp-docs-0001',
      'compose.one?composeId=cmp-gone-0002',
      'project.all',
    ])
  })

  it('skips a resource removed between the list and its read', async () => {
    const records = await inventory().run()
    expect(records.some((r) => r.externalId === 'cmp-gone-0002')).toBe(false)
  })

  it('keeps no secret value from any answer', async () => {
    const records = await inventory().run()
    expect(JSON.stringify(records)).not.toContain(SECRET_MARKER)
  })

  it('fails the whole read when a resource read fails for another reason', async () => {
    const routes: Record<string, string | Response> = {
      ...dokployRoutes(),
      'compose.one?composeId=cmp-docs-0001': new Response('boom', { status: 502 }),
    }
    await expect(inventory(routes).run()).rejects.toMatchObject({
      code: 'server_error',
    })
  })

  it('skips a resource whose answer is not an object and an unexpected list shape fails', async () => {
    const skipped = await inventory({
      ...dokployRoutes(),
      'application.one?applicationId=app-proxy-0002': '"nope"',
    }).run()
    expect(skipped.some((r) => r.externalId === 'app-proxy-0002')).toBe(false)
    await expect(inventory({ 'project.all': '{"items": []}' }).run()).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
})

describe('the Dokploy client', () => {
  it('normalises the instance URL', () => {
    expect(normalizeDokployUrl('https://dokploy.example.dev/')).toBe(BASE)
    expect(normalizeDokployUrl('https://dokploy.example.dev/api')).toBe(BASE)
    expect(normalizeDokployUrl('https://dokploy.example.dev/swagger/')).toBe(BASE)
    expect(normalizeDokployUrl('http://192.0.2.4:3000')).toBe('http://192.0.2.4:3000')
    expect(() => normalizeDokployUrl('ftp://dokploy.example.dev')).toThrow(DokployError)
    expect(() => normalizeDokployUrl('https://u:p@dokploy.example.dev')).toThrow(DokployError)
  })

  it('names the route, never the key or the body, when a request fails', async () => {
    const { impl } = fakeDokployFetch({
      'project.all': new Response(`{"echo": "${SECRET_MARKER}-in-body ${KEY}"}`, { status: 401 }),
      'application.one?applicationId=a': `not json ${SECRET_MARKER}`,
    })
    const client = createDokployClient({ baseUrl: BASE, token: KEY, fetch: impl })
    for (const call of [
      () => client.get('project.all'),
      () => client.get('application.one', { applicationId: 'a' }),
    ]) {
      const error = await call().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DokployError)
      const text = `${String(error)} ${JSON.stringify(error)} ${String((error as Error).cause)}`
      expect(text).not.toContain(SECRET_MARKER)
      expect(text).not.toContain(KEY)
    }
  })

  it('maps network failures and timeouts', async () => {
    const down = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch
    const slow = (() =>
      Promise.reject(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      )) as typeof fetch
    await expect(
      createDokployClient({ baseUrl: BASE, token: KEY, fetch: down }).get('project.all'),
    ).rejects.toMatchObject({ code: 'network' })
    await expect(
      createDokployClient({ baseUrl: BASE, token: KEY, fetch: slow }).get('project.all'),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('refuses an empty key', () => {
    expect(() => createDokployClient({ baseUrl: BASE, token: '  ' })).toThrow(DokployError)
  })
})

describe('withoutCredentials', () => {
  it('drops a user and password from a git URL', () => {
    expect(withoutCredentials('https://bot:tok@git.example.dev/a/b.git')).toBe(
      'https://git.example.dev/a/b.git',
    )
    expect(withoutCredentials('https://git.example.dev/a/b.git')).toBe(
      'https://git.example.dev/a/b.git',
    )
    expect(withoutCredentials('git@git.example.dev:a/b.git')).toBe('git@git.example.dev:a/b.git')
  })
})

describe('testDokployConnection', () => {
  it('counts the projects and reads the version', async () => {
    const { impl } = fakeDokployFetch()
    expect(await testDokployConnection({ baseUrl: BASE, token: KEY, fetch: impl })).toEqual({
      ok: true,
      version: 'v0.25.0',
      projects: 2,
    })
  })

  it('connects without the version when that route is refused', async () => {
    const { impl } = fakeDokployFetch({
      'project.all': '[]',
      'settings.getDokployVersion': new Response('', { status: 403 }),
    })
    expect(await testDokployConnection({ baseUrl: BASE, token: KEY, fetch: impl })).toEqual({
      ok: true,
      version: null,
      projects: 0,
    })
  })

  it('reports a rejected key', async () => {
    const { impl } = fakeDokployFetch({
      'project.all': new Response('', { status: 401 }),
    })
    expect(await testDokployConnection({ baseUrl: BASE, token: KEY, fetch: impl })).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
  })
})
