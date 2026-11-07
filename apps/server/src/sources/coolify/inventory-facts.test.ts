import type { DeploymentFacts } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { fetchCoolifyInventory, type CachedFacts } from './inventory.js'

// Facts reading on top of the inventory: which calls are made, and when stored facts are reused.

const SECRET = 'fictional-secret-91c2'
const UPDATED = '2026-11-01T08:00:00.000000Z'
const now = new Date('2026-11-07T10:00:00.000Z')
const config = { name: 'main', baseUrl: 'https://coolify.example.dev', token: 'tok-123' }

const application = {
  uuid: 'app-api',
  name: 'kestrel-api',
  git_repository: 'kestrel-co/api',
  git_branch: 'main',
  build_pack: 'nixpacks',
  custom_docker_run_options: `--user 1000 -e API_KEY=${SECRET}`,
  destination_id: 3,
  environment_id: 11,
  status: 'running:healthy',
  updated_at: UPDATED,
}

const database = {
  uuid: 'db-pg',
  name: 'kestrel-pg',
  image: 'postgres:17',
  destination_id: 3,
  environment_id: 21,
  postgres_password: SECRET,
  updated_at: UPDATED,
}

function fakeCoolify(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/applications': [application],
    '/services': [],
    '/servers': [{ id: 1, uuid: 'srv-1', name: 'edge-1' }],
    '/databases': [database],
    '/applications/app-api': {
      ...application,
      settings: { is_auto_deploy_enabled: true },
      environment_variables: [{ key: 'API_KEY', value: SECRET }],
    },
    '/applications/app-api/storages': {
      persistent_storages: [],
      file_storages: [{ fs_path: '/srv/api/.env', mount_path: '/app/.env', content: SECRET }],
    },
    '/databases/db-pg/storages': { persistent_storages: [], file_storages: [] },
    '/projects': [
      { id: 1, uuid: 'proj-shop', name: 'kestrel-shop' },
      { id: 2, uuid: 'proj-blog', name: 'kestrel-blog', environments: [{ id: 21, name: 'prod' }] },
    ],
    '/projects/proj-shop/environments': [{ id: 11, name: 'production', project_id: 1 }],
    ...overrides,
  }
  const paths: string[] = []
  const respond = (input: string | URL | Request): Response => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v1/, '')
    paths.push(path)
    const route = routes[path]
    if (route === undefined) return new Response('not found', { status: 404 })
    if (typeof route === 'function') return (route as () => Response)()
    return new Response(JSON.stringify(route), { status: 200 })
  }
  const impl = ((input: string | URL | Request) => Promise.resolve(respond(input))) as typeof fetch
  return { impl, paths }
}

async function inventory(
  fake: ReturnType<typeof fakeCoolify>,
  cached?: Record<string, CachedFacts>,
  at: Date = now,
) {
  const records = await fetchCoolifyInventory({
    ...config,
    fetch: fake.impl,
    facts: { now: () => at, ...(cached && { cached: (id) => cached[id] }) },
  })
  return new Map(records.map((r) => [r.externalId, r]))
}

const perResource = (paths: string[]) =>
  paths.filter((p) => /^\/(applications|databases)\/./.test(p))

describe('fetchCoolifyInventory facts', () => {
  it('reads settings, storages and projects for resources it has no facts for', async () => {
    const fake = fakeCoolify()
    const byId = await inventory(fake)
    const api = byId.get('app-api')
    expect(api?.factsVersion).toBe(UPDATED)
    expect(api?.facts).toMatchObject({
      fetchedAt: now.toISOString(),
      buildPack: 'nixpacks',
      user: '1000',
      autoDeploy: true,
      project: { key: 'proj-shop', name: 'kestrel-shop', environment: 'production' },
      mounts: [{ origin: 'file_storage', source: '/srv/api/.env', target: '/app/.env' }],
      mountsChecked: ['run_options', 'file_storage', 'persistent_storage'],
    })
    expect(byId.get('db-pg')?.facts).toMatchObject({
      image: 'postgres:17',
      project: { key: 'proj-blog', environment: 'prod' },
    })
    // Embedded environments save the per project call.
    expect(fake.paths).not.toContain('/projects/proj-blog/environments')
    expect(perResource(fake.paths).sort()).toEqual([
      '/applications/app-api',
      '/applications/app-api/storages',
      '/databases/db-pg/storages',
    ])
    // Environment values, passwords and file storage contents are not kept.
    expect(JSON.stringify([...byId.values()])).not.toContain(SECRET)
  })

  it('skips the detail call when the list already carries settings', async () => {
    const fake = fakeCoolify({
      '/applications': [{ ...application, settings: { is_auto_deploy_enabled: false } }],
    })
    const byId = await inventory(fake)
    expect(byId.get('app-api')?.facts?.autoDeploy).toBe(false)
    expect(fake.paths).not.toContain('/applications/app-api')
  })

  it('reuses stored facts while updated_at has not moved, without any extra call', async () => {
    const first = await inventory(fakeCoolify())
    const cached: Record<string, CachedFacts> = {}
    for (const [id, r] of first)
      cached[id] = { version: r.factsVersion ?? null, facts: r.facts ?? null }

    const fake = fakeCoolify()
    const later = new Date(now.getTime() + 60 * 60 * 1000)
    const byId = await inventory(fake, cached, later)
    expect(fake.paths.sort()).toEqual(['/applications', '/databases', '/servers', '/services'])
    expect(byId.get('app-api')?.facts).toEqual(first.get('app-api')?.facts)
    expect(byId.get('app-api')?.factsVersion).toBe(UPDATED)
  })

  it('reads again only the resource whose updated_at moved', async () => {
    const first = await inventory(fakeCoolify())
    const cached: Record<string, CachedFacts> = {}
    for (const [id, r] of first)
      cached[id] = { version: r.factsVersion ?? null, facts: r.facts ?? null }

    const moved = '2026-11-06T09:00:00.000000Z'
    const fake = fakeCoolify({ '/databases': [{ ...database, updated_at: moved }] })
    const byId = await inventory(fake, cached)
    expect(perResource(fake.paths)).toEqual(['/databases/db-pg/storages'])
    expect(fake.paths).toContain('/projects')
    expect(byId.get('db-pg')?.factsVersion).toBe(moved)
  })

  it('reads again facts older than a day', async () => {
    const first = await inventory(fakeCoolify())
    const cached: Record<string, CachedFacts> = {}
    for (const [id, r] of first)
      cached[id] = { version: r.factsVersion ?? null, facts: r.facts ?? null }

    const fake = fakeCoolify()
    await inventory(fake, cached, new Date(now.getTime() + 25 * 60 * 60 * 1000))
    expect(perResource(fake.paths)).toHaveLength(3)
  })

  it('records a gap when storages and projects cannot be listed', async () => {
    const fake = fakeCoolify({
      '/applications/app-api/storages': () => new Response('', { status: 404 }),
      '/projects': () => new Response('', { status: 403 }),
    })
    const byId = await inventory(fake)
    const facts = byId.get('app-api')?.facts as DeploymentFacts
    expect(facts.gaps.mounts).toBe('Coolify did not list the storages of this resource')
    expect(facts.gaps.project).toBeDefined()
    expect(facts.mountsChecked).toEqual(['run_options'])
    // A permanent answer is cached like any other read.
    expect(byId.get('app-api')?.factsVersion).toBe(UPDATED)
  })

  it('keeps stored facts on a transient failure and retries next scan', async () => {
    const stored = (await inventory(fakeCoolify())).get('app-api')?.facts ?? null
    const fake = fakeCoolify({
      '/applications': [{ ...application, updated_at: '2026-11-07T09:00:00Z' }],
      '/applications/app-api/storages': () => new Response('', { status: 502 }),
    })
    const byId = await inventory(fake, { 'app-api': { version: UPDATED, facts: stored } })
    expect(byId.get('app-api')?.facts).toEqual(stored)
    expect(byId.get('app-api')?.factsVersion).toBeNull()
  })

  it('builds facts with a gap on a transient failure when nothing is stored', async () => {
    const fake = fakeCoolify({
      '/applications/app-api/storages': () => new Response('', { status: 503 }),
    })
    const byId = await inventory(fake)
    expect(byId.get('app-api')?.facts?.gaps.mounts).toBeDefined()
    expect(byId.get('app-api')?.factsVersion).toBeNull()
  })
})
