import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl } from './client.js'
import { CoolifyError } from './errors.js'
import { fetchCoolifyInventory, testCoolifyConnection } from './inventory.js'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')

type Handler = (path: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(routes: Record<string, string | Handler>) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, '')
    const route = routes[path]
    if (route === undefined) return new Response('not found', { status: 404 })
    return typeof route === 'string' ? new Response(route, { status: 200 }) : route(path, init)
  }) as typeof fetch
  return { impl, calls }
}

const okRoutes = {
  '/applications': fixture('applications'),
  '/services': fixture('services'),
  '/servers': fixture('servers'),
  '/databases': fixture('databases'),
  '/version': '4.0.0-beta.999',
}

const config = { name: 'main', baseUrl: 'https://coolify.example.dev', token: 'tok-123' }

describe('fetchCoolifyInventory', () => {
  it('normalises applications, services and databases', async () => {
    const { impl, calls } = fakeFetch(okRoutes)
    const records = await fetchCoolifyInventory({ ...config, fetch: impl })
    const byId = Object.fromEntries(records.map((r) => [r.externalId, r]))

    expect(records).toHaveLength(7)
    expect(
      calls.every(
        (c) => (c.init.headers as Record<string, string>).Authorization === 'Bearer tok-123',
      ),
    ).toBe(true)

    expect(byId['app-web-001']).toMatchObject({
      source: 'main',
      kind: 'application',
      repo: 'kestrel-co/web',
      gitRepository: expect.stringContaining('kestrel-co/web') as unknown,
      branch: 'main',
      domains: ['https://www.example.dev', 'https://example.dev'],
      isPublic: true,
      server: 'edge-1',
      status: 'running:healthy',
      watchPaths: ['apps/web/**', 'packages/ui/**'],
      lastDeployAt: '2026-10-30T10:15:00.000Z',
    })
    // ssh url, server resolved through server_id
    expect(byId['app-api-002']).toMatchObject({
      repo: 'kestrel-co/api',
      branch: 'release',
      server: 'edge-2',
    })
    // missing fields: no domain, no updated_at, server via destination.server_id
    expect(byId['app-worker-003']).toMatchObject({
      domains: [],
      isPublic: false,
      lastDeployAt: null,
      watchPaths: null,
      image: null,
      server: 'edge-1',
    })
    // image app without repo, domain without scheme is not public
    expect(byId['app-img-004']).toMatchObject({
      repo: null,
      branch: null,
      gitRepository: null,
      image: 'ghcr.io/kestrel-co/docs:1.4.2',
      domains: ['docs.example.dev'],
      isPublic: false,
    })
    // service takes domains and images from sub applications
    expect(byId['svc-wiki-001']).toMatchObject({
      kind: 'service',
      gitRepository: null,
      domains: ['https://wiki.example.dev'],
      isPublic: true,
      image: 'example/wiki:3.1, redis:7',
      server: 'edge-2',
    })
    expect(byId['svc-internal-002']).toMatchObject({
      isPublic: false,
      server: 'edge-1',
      status: 'running:healthy',
    })
    // wrapped list shape
    expect(byId['db-pg-001']).toMatchObject({
      kind: 'database',
      image: 'postgres:17',
      repo: null,
      server: 'edge-2',
    })
  })

  it('treats a missing databases endpoint as empty', async () => {
    const { impl } = fakeFetch({
      '/applications': '[]',
      '/services': '[]',
      '/servers': fixture('servers'),
    })
    expect(await fetchCoolifyInventory({ ...config, fetch: impl })).toEqual([])
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'http_error'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { impl } = fakeFetch({
      ...okRoutes,
      '/applications': () => new Response('x', { status }),
    })
    await expect(fetchCoolifyInventory({ ...config, fetch: impl })).rejects.toMatchObject({
      code,
      status,
    })
  })

  it('maps a network failure and a timeout', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    await expect(fetchCoolifyInventory({ ...config, fetch: down })).rejects.toMatchObject({
      code: 'network',
    })

    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('timed out', 'TimeoutError')),
        )
      })) as unknown as typeof fetch
    await expect(
      fetchCoolifyInventory({ ...config, timeoutMs: 20, fetch: slow }),
    ).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('rejects bad bodies', async () => {
    const html = fakeFetch({ ...okRoutes, '/applications': '<html>login</html>' })
    await expect(fetchCoolifyInventory({ ...config, fetch: html.impl })).rejects.toMatchObject({
      code: 'invalid_response',
    })
    const obj = fakeFetch({ ...okRoutes, '/applications': '{"message":"hi"}' })
    await expect(fetchCoolifyInventory({ ...config, fetch: obj.impl })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('never leaks the token in error messages', async () => {
    const { impl } = fakeFetch({
      ...okRoutes,
      '/applications': () => new Response('x', { status: 401 }),
    })
    const err = await fetchCoolifyInventory({ ...config, fetch: impl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoolifyError)
    expect((err as Error).message).not.toContain('tok-123')
  })
})

describe('testCoolifyConnection', () => {
  it('returns the version', async () => {
    const { impl } = fakeFetch(okRoutes)
    expect(
      await testCoolifyConnection({ baseUrl: config.baseUrl, token: 'tok', fetch: impl }),
    ).toEqual({
      ok: true,
      version: '4.0.0-beta.999',
    })
  })

  it('succeeds without a version when the endpoint is missing', async () => {
    const { impl } = fakeFetch({ '/servers': fixture('servers') })
    expect(
      await testCoolifyConnection({ baseUrl: config.baseUrl, token: 'tok', fetch: impl }),
    ).toEqual({
      ok: true,
      version: null,
    })
  })

  it('reports a bad token, a bad url and an empty token', async () => {
    const { impl } = fakeFetch({ '/servers': () => new Response('', { status: 401 }) })
    expect(
      await testCoolifyConnection({ baseUrl: config.baseUrl, token: 'bad', fetch: impl }),
    ).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
    expect(await testCoolifyConnection({ baseUrl: 'ftp://x', token: 't' })).toMatchObject({
      ok: false,
      code: 'invalid_config',
    })
    expect(await testCoolifyConnection({ baseUrl: config.baseUrl, token: ' ' })).toMatchObject({
      ok: false,
      code: 'invalid_config',
    })
  })
})

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://coolify.example.dev', 'https://coolify.example.dev'],
    ['https://coolify.example.dev/', 'https://coolify.example.dev'],
    ['https://coolify.example.dev/api/v1', 'https://coolify.example.dev'],
    ['http://10.0.0.5:8000/api', 'http://10.0.0.5:8000'],
    ['https://example.dev/coolify/', 'https://example.dev/coolify'],
  ])('%s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected)
  })

  it('rejects junk', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow(CoolifyError)
  })
})
