import { readFileSync } from 'node:fs'
import { COOLIFY_CAPABILITIES, DOKPLOY_CAPABILITIES } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { fakeDokployFetch } from '../dokploy/testing.js'
import { openDeploymentSource, type DeploymentSourceStore } from './registry.js'

// The registry binds a stored source to its kind; the Coolify adapter is checked through it.
// Every name, domain and token is fictional.

const fixture = (name: string): string =>
  readFileSync(new URL(`../coolify/fixtures/${name}.json`, import.meta.url), 'utf8')

const ROUTES: Record<string, string> = {
  '/applications': fixture('applications'),
  '/services': fixture('services'),
  '/servers': fixture('servers'),
  '/databases': fixture('databases'),
}

function fakeFetch(routes: Record<string, string>) {
  const asked: { path: string; auth: string | undefined }[] = []
  const impl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname.replace('/api/v1', '')
    asked.push({ path, auth: (init.headers as Record<string, string>).Authorization })
    const body = routes[path]
    return Promise.resolve(
      body === undefined ? new Response('not found', { status: 404 }) : new Response(body),
    )
  }) as typeof fetch
  return { impl, asked }
}

const ROW = {
  id: 7,
  kind: 'coolify' as const,
  name: 'main',
  baseUrl: 'https://coolify.example.dev',
}

const store = (token: string | null | Error): DeploymentSourceStore => ({
  getToken: () => {
    if (token instanceof Error) throw token
    return token
  },
})

describe('openDeploymentSource', () => {
  it('opens nothing for sources that report no deployments', () => {
    expect(openDeploymentSource({ ...ROW, kind: 'github' }, store('t'))).toBeNull()
    expect(openDeploymentSource({ ...ROW, kind: 'osv' }, store('t'))).toBeNull()
  })

  it('binds a Coolify row to the Coolify adapter with its declared capabilities', async () => {
    const { impl, asked } = fakeFetch(ROUTES)
    const source = openDeploymentSource(ROW, store('fictional-token-01'), { fetch: impl })!
    expect(source).toMatchObject({ sourceId: 7, kind: 'coolify', name: 'main' })
    expect(source.capabilities).toBe(COOLIFY_CAPABILITIES)
    expect(source.deployHistory).toBeTypeOf('function')
    expect(source.imageScan).toBeDefined()

    const records = await source.inventory()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.source === 'main')).toBe(true)
    expect(asked.every((a) => a.auth === 'Bearer fictional-token-01')).toBe(true)
  })

  it('binds a Dokploy row to the Dokploy adapter, inventory only', async () => {
    const { impl, asked } = fakeDokployFetch()
    const source = openDeploymentSource(
      { ...ROW, kind: 'dokploy', name: 'apps', baseUrl: 'https://dokploy.example.dev' },
      store('fictional-dokploy-key-01'),
      { fetch: impl },
    )!
    expect(source).toMatchObject({ sourceId: 7, kind: 'dokploy', name: 'apps' })
    expect(source.capabilities).toBe(DOKPLOY_CAPABILITIES)
    expect(source.capabilities.facts.size).toBe(0)
    expect(source.deployHistory).toBeUndefined()
    expect(source.imageScan).toBeUndefined()
    const records = await source.inventory()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.source === 'apps')).toBe(true)
    expect(asked.every((a) => a.apiKey === 'fictional-dokploy-key-01')).toBe(true)
  })

  it('fails a Dokploy inventory without a URL with a message', async () => {
    const source = openDeploymentSource(
      { ...ROW, kind: 'dokploy', name: 'apps', baseUrl: null },
      store('fictional-dokploy-key-01'),
    )!
    await expect(source.inventory()).rejects.toThrow('The source "apps" has no URL.')
  })

  it('passes the stored facts to the inventory so unchanged resources are not read again', async () => {
    const { impl } = fakeFetch(ROUTES)
    const asked: number[] = []
    const source = openDeploymentSource(
      ROW,
      {
        getToken: () => 'fictional-token-01',
        cachedFacts: (id) => {
          asked.push(id)
          return new Map()
        },
      },
      { fetch: impl },
    )!
    await source.inventory()
    expect(asked).toEqual([7])
  })

  it('fails on use, never on open, when the token is missing or cannot be read', async () => {
    const missing = openDeploymentSource(ROW, store(null))!
    await expect(missing.inventory()).rejects.toThrow('The source "main" has no token.')

    const broken = openDeploymentSource(ROW, store(new Error('bad key 9f1e')))!
    const message = await broken.inventory().then(
      () => '',
      (e: unknown) => (e as Error).message,
    )
    expect(message).toBe('The token of "main" cannot be read. Check HINOMI_SECRET_KEY.')
    expect(message).not.toContain('9f1e')
  })

  it('refuses an inventory without a URL', async () => {
    const source = openDeploymentSource({ ...ROW, baseUrl: null }, store('t'))!
    await expect(source.inventory()).rejects.toThrow('The source "main" has no URL.')
  })
})

describe('the Coolify deploy history', () => {
  it('answers for applications only', async () => {
    const source = openDeploymentSource(ROW, store('t'))!
    const read = await source.deployHistory!({ kind: 'service', externalId: 'svc-1' }, 5)
    expect(read).toEqual({
      ok: false,
      reason: 'Coolify keeps a deploy history for applications only.',
    })
  })

  it('says why instead of throwing when the source cannot be used', async () => {
    const noToken = openDeploymentSource(ROW, store(null))!
    expect(await noToken.deployHistory!({ kind: 'application', externalId: 'app-1' }, 5)).toEqual({
      ok: false,
      reason: 'The source "main" has no token.',
    })
    const noUrl = openDeploymentSource({ ...ROW, baseUrl: null }, store('t'))!
    expect(await noUrl.deployHistory!({ kind: 'application', externalId: 'app-1' }, 5)).toEqual({
      ok: false,
      reason: 'The source "main" has no URL.',
    })
  })
})
