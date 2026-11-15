import { deploymentRecordSchema, mountsDockerSocket } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { BROAD_ACCESS_WARNING, testDockerConnection } from './connection.js'
import { parseInspect, stripEnv } from './facts.js'
import { containerListPath, fetchDockerInventory } from './inventory.js'
import { ownContainerIds, isOwnContainer } from './self.js'
import { fakeTransport, fixture, fixtureRoutes } from './testing.js'

const NOW = () => new Date('2026-11-15T12:00:00.000Z')
const SELF_ID = 'e4' + 'e'.repeat(62)

async function inventory(over: { optIn?: boolean; ownIds?: string[] } = {}) {
  const { transport, calls } = fakeTransport(fixtureRoutes())
  const records = await fetchDockerInventory({
    transport,
    name: 'edge-1',
    optIn: over.optIn ?? true,
    ownIds: over.ownIds ?? [SELF_ID],
    now: NOW,
  })
  return { records, calls, byId: new Map(records.map((r) => [r.externalId, r])) }
}

describe('fetchDockerInventory', () => {
  it('lists opted in containers, inspects each and sends only GET', async () => {
    const { records, calls } = await inventory()
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls[0]!.path).toBe(containerListPath(true))
    expect(decodeURIComponent(calls[0]!.path)).toContain('{"label":["hinomi.enable=true"]}')
    // The id that is not an id is never put in a path; Hinomi's own container is skipped.
    expect(
      calls.map((c) => c.path).filter((p) => p.includes('/json') && p !== calls[0]!.path),
    ).toHaveLength(4)
    expect(calls.some((c) => c.path.includes('not-an-id') || c.path.includes(SELF_ID))).toBe(false)
    expect(records.map((r) => r.externalId).sort()).toEqual([
      'compose:kestrel-shop/web',
      'container:kestrel-api',
      'container:kestrel-blog',
    ])
    for (const record of records) expect(deploymentRecordSchema.parse(record)).toEqual(record)
  })

  it('reads every container without the opt in label filter when it is off', () => {
    expect(containerListPath(false)).toBe('/containers/json?all=1')
  })

  it('never keeps an environment variable', async () => {
    const { records } = await inventory()
    expect(JSON.stringify(records)).not.toContain('env-must-not-leak')
    expect(JSON.stringify(records)).not.toContain('KESTREL_FIXTURE_ENV')
  })

  it('maps a plain container: repo, commit, domains from Traefik, user and networks', async () => {
    const api = (await inventory()).byId.get('container:kestrel-api')!
    expect(api).toMatchObject({
      source: 'edge-1',
      name: 'kestrel-api',
      kind: 'application',
      repo: 'kestrel-co/kestrel-api',
      gitRepository: 'https://github.com/kestrel-co/kestrel-api',
      branch: 'main',
      domains: ['https://api.example.com', 'https://www.api.example.com'],
      isPublic: true,
      server: 'edge-1',
      status: 'running:healthy',
      image: 'ghcr.io/kestrel-co/kestrel-api:1.4.2',
      lastDeployAt: '2026-11-01T10:00:00.000Z',
      watchPaths: null,
    })
    expect(api.facts).toMatchObject({
      fetchedAt: '2026-11-15T12:00:00.000Z',
      commit: '0123456789abcdef0123456789abcdef01234567',
      user: 'node',
      userOrigin: 'docker_inspect',
      mountsChecked: ['docker_inspect'],
      hostNetwork: false,
      privileged: false,
      attachedToDestination: false,
      destination: null,
      project: { key: 'kestrel-api', name: 'kestrel-api', environment: null },
    })
    expect(api.facts!.mounts).toEqual([
      {
        origin: 'docker_inspect',
        type: 'volume',
        source: 'kestrel-api-data',
        target: '/data',
        readOnly: false,
        service: null,
      },
    ])
    expect(api.facts!.networks.map((n) => n.name)).toEqual(['edge', 'kestrel-api_default'])
    expect(api.facts!.gaps.watchPaths).toBeTruthy()
  })

  it('groups compose replicas into one service and joins their mounts and networks', async () => {
    const web = (await inventory()).byId.get('compose:kestrel-shop/web')!
    expect(web).toMatchObject({
      name: 'kestrel-shop/web',
      kind: 'service',
      // hinomi.repo wins over an OCI source label a base image left behind.
      repo: 'kestrel-co/kestrel-shop',
      domains: ['https://shop.example.com', 'http://shop-legacy.example.com'],
      status: 'running',
    })
    expect(web.facts!.user).toBe('')
    expect(web.facts!.project!.key).toBe('kestrel-shop')
    expect(mountsDockerSocket(web.facts!.mounts)).toBe(true)
    expect(web.facts!.mounts.map((m) => m.source)).toEqual([
      '/var/run/docker.sock',
      '/srv/kestrel-shop/uploads',
    ])
    expect(web.facts!.mounts[0]!.readOnly).toBe(true)
    expect(web.facts!.networks.map((n) => n.name)).toEqual(['edge', 'kestrel-shop_default'])
  })

  it('marks host networking, privileged mode and a port published on every interface', async () => {
    const blog = (await inventory()).byId.get('container:kestrel-blog')!
    expect(blog).toMatchObject({ domains: [], isPublic: true, repo: null })
    expect(blog.facts).toMatchObject({
      user: '0:0',
      hostNetwork: true,
      privileged: true,
      networks: [],
      project: { key: 'kestrel-blog' },
    })
  })

  it('skips a container that is gone between the list and the inspect', async () => {
    const routes = fixtureRoutes()
    delete routes[`/containers/${'d3' + 'd'.repeat(62)}/json`]
    const { transport } = fakeTransport(routes)
    const records = await fetchDockerInventory({
      transport,
      name: 'edge-1',
      optIn: true,
      ownIds: [],
    })
    expect(records.map((r) => r.externalId)).not.toContain('container:kestrel-blog')
  })

  it('fails as a whole when the list cannot be read', async () => {
    const { transport } = fakeTransport({ '/containers/json': () => ({ status: 403, body: {} }) })
    await expect(
      fetchDockerInventory({ transport, name: 'edge-1', optIn: true }),
    ).rejects.toMatchObject({ code: 'http_error' })
  })
})

describe('inspect parsing', () => {
  it('strips Config.Env before validation', () => {
    const raw = fixture('inspect-aaaa') as { Config: Record<string, unknown> }
    stripEnv(raw)
    expect(raw.Config).not.toHaveProperty('Env')
    const parsed = parseInspect(fixture('inspect-aaaa'))
    expect(JSON.stringify(parsed)).not.toContain('env-must-not-leak')
    expect(parsed!.Config).not.toHaveProperty('Cmd')
  })
})

describe('own container', () => {
  it('reads its id from the hostname and the cgroup and mount tables', () => {
    const full = 'f'.repeat(64)
    const files: Record<string, string> = {
      '/proc/self/cgroup': `0::/system.slice/docker-${full}.scope\n`,
      '/proc/self/mountinfo': '1 2 0:1 / / rw - overlay overlay rw\n',
    }
    const ids = ownContainerIds((p) => files[p] ?? null, 'abcdef012345')
    expect(ids).toEqual(['abcdef012345', full])
    expect(isOwnContainer('abcdef012345' + '0'.repeat(52), ids)).toBe(true)
    expect(isOwnContainer(full, ids)).toBe(true)
    expect(isOwnContainer('1'.repeat(64), ids)).toBe(false)
    expect(ownContainerIds(() => null, 'hinomi-server')).toEqual([])
  })
})

describe('testDockerConnection', () => {
  it('warns when GET /info answers (raw socket or a broad proxy)', async () => {
    const { transport, calls } = fakeTransport({ ...fixtureRoutes(), '/info': { ID: 'x' } })
    const result = await testDockerConnection(transport, true)
    expect(result).toEqual({
      ok: true,
      version: '27.3.1',
      containers: 6,
      warning: BROAD_ACCESS_WARNING,
    })
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('has no warning behind a GET only proxy that refuses /info', async () => {
    const { transport } = fakeTransport({
      ...fixtureRoutes(),
      '/info': () => ({ status: 403, body: {} }),
    })
    expect(await testDockerConnection(transport, false)).toMatchObject({ ok: true, warning: null })
  })

  it('fails when the container list is refused', async () => {
    const { transport } = fakeTransport({
      '/_ping': 'OK',
      '/version': {},
      '/containers/json': () => ({ status: 403, body: {} }),
    })
    expect(await testDockerConnection(transport, true)).toMatchObject({ ok: false })
  })
})
