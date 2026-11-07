import { repoDetailSchema, sourcesResponseSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createTestApi } from './testing.js'

// Repos read through one of several GitHub sources, as the API shows and changes it.

const AT = new Date('2026-11-07T06:00:00Z')

function world() {
  const api = createTestApi()
  const { repos } = api
  const co = repos.sources.create({ kind: 'github', name: 'kestrel-co', token: 'ghp_fictional01' })
  const labs = repos.sources.create({
    kind: 'github',
    name: 'kestrel-labs',
    token: 'ghp_fictional02',
  })
  const edge = repos.sources.create({
    kind: 'coolify',
    name: 'edge-1',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-fictional',
  })
  repos.deployments.upsert({
    sourceId: edge.id,
    externalId: 'app-1',
    kind: 'application',
    name: 'harbor-web',
  })
  const shared = repos.repos.upsert({ owner: 'kestrel-co', name: 'shared-ui' })
  const harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  repos.repoSources.record(shared.id, co.id, true, AT)
  repos.repoSources.record(shared.id, labs.id, true, AT)
  repos.repoSources.record(harbor.id, co.id, true, AT)
  repos.repoSources.setOwner(shared.id, co.id)
  repos.repoSources.setOwner(harbor.id, co.id)
  return { ...api, co, labs, edge, shared, harbor }
}

describe('GET /api/sources counts', () => {
  it('says how many repos each GitHub source reads and how many deployments Coolify reports', async () => {
    const { call, labs, shared, repos } = world()
    const counts = async () =>
      Object.fromEntries(
        sourcesResponseSchema
          .parse((await call('GET', '/sources')).json)
          .sources.map((s) => [s.name, [s.repoCount, s.deploymentCount]]),
      )
    expect(await counts()).toEqual({
      'kestrel-co': [2, 0],
      'kestrel-labs': [0, 0],
      'edge-1': [0, 1],
    })
    repos.repoSources.setOverride(shared.id, labs.id)
    expect(await counts()).toMatchObject({ 'kestrel-co': [1, 0], 'kestrel-labs': [1, 0] })
  })
})

describe('GET and PATCH /api/repos/:id', () => {
  it('shows the source a repo uses and the sources that see it', async () => {
    const { call, co, labs, shared } = world()
    const res = await call('GET', `/repos/${shared.id}`)
    expect(res.status).toBe(200)
    const detail = repoDetailSchema.parse(res.json)
    expect(detail).toMatchObject({
      fullName: 'kestrel-co/shared-ui',
      source: {
        current: { id: co.id, name: 'kestrel-co', auth: 'token', enabled: true },
        mode: 'auto',
        overrideId: null,
      },
    })
    expect(detail.source.seenBy.map((s) => [s.id, s.alertsReadable])).toEqual([
      [co.id, true],
      [labs.id, true],
    ])
    expect(res.text).not.toContain('ghp_fictional')
    expect((await call('GET', '/repos/999')).status).toBe(404)
  })

  it('picks a source by hand and clears it again', async () => {
    const { call, co, labs, shared } = world()
    const picked = await call('PATCH', `/repos/${shared.id}`, { sourceId: labs.id })
    expect(picked.status).toBe(200)
    expect(repoDetailSchema.parse(picked.json).source).toMatchObject({
      current: { id: labs.id },
      mode: 'override',
      overrideId: labs.id,
    })
    const cleared = await call('PATCH', `/repos/${shared.id}`, { sourceId: null })
    expect(repoDetailSchema.parse(cleared.json).source).toMatchObject({
      current: { id: co.id },
      mode: 'auto',
      overrideId: null,
    })
  })

  it('refuses a source that is not a usable GitHub source', async () => {
    const { call, repos, labs, edge, shared } = world()
    expect((await call('PATCH', `/repos/${shared.id}`, { sourceId: edge.id })).status).toBe(404)
    expect((await call('PATCH', `/repos/${shared.id}`, { sourceId: 999 })).status).toBe(404)
    repos.sources.update(labs.id, { enabled: false })
    const off = await call('PATCH', `/repos/${shared.id}`, { sourceId: labs.id })
    expect(off.status).toBe(409)
    expect((await call('PATCH', `/repos/${shared.id}`, {})).status).toBe(400)
    expect((await call('PATCH', '/repos/999', { sourceId: null })).status).toBe(404)
  })
})

describe('DELETE /api/sources/:id with repos', () => {
  it('moves the repos to another source that sees them and keeps the rest unread', async () => {
    const { call, co, labs, shared, harbor } = world()
    expect((await call('DELETE', `/sources/${co.id}`)).status).toBe(204)
    const sharedNow = repoDetailSchema.parse((await call('GET', `/repos/${shared.id}`)).json)
    expect(sharedNow.source).toMatchObject({ current: { id: labs.id }, mode: 'auto' })
    const harborNow = repoDetailSchema.parse((await call('GET', `/repos/${harbor.id}`)).json)
    // Only kestrel-labs is left, so it is tried for a repo no source reads.
    expect(harborNow.source).toMatchObject({ current: { id: labs.id }, mode: 'fallback' })
    expect(harborNow.source.seenBy).toEqual([])
  })

  it('switching a source off moves its repos too', async () => {
    const { call, co, labs, shared } = world()
    const res = await call('PATCH', `/sources/${co.id}`, { enabled: false })
    expect(res.status).toBe(200)
    expect(
      repoDetailSchema.parse((await call('GET', `/repos/${shared.id}`)).json).source.current,
    ).toMatchObject({ id: labs.id })
    const list = sourcesResponseSchema.parse((await call('GET', '/sources')).json)
    expect(list.sources.find((s) => s.id === labs.id)?.repoCount).toBe(1)
    expect(list.sources.find((s) => s.id === co.id)?.repoCount).toBe(0)
  })
})
