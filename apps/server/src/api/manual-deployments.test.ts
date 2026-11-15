import { deploymentItemSchema, importManualDeploymentsResponseSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { nowMs } from '@hinomi/shared'
import { buildScanSources, syncDeployments } from '../scan/index.js'
import { createTestApi } from './testing.js'

// The manual deployment list through the API and the scan. Every name is fictional.

async function world() {
  const api = createTestApi()
  const created = await api.call('POST', '/sources', { kind: 'manual', name: 'Manual list' })
  expect(created.status).toBe(201)
  const sourceId = (created.json as { id: number }).id
  return { ...api, sourceId }
}

const ENTRY = {
  name: 'partner-portal',
  repo: 'example-org/portal',
  branch: 'main',
  image: 'registry.example.com/portal:1.0.0',
  domains: ['https://portal.example.com/'],
  server: 'edge-1',
}

describe('manual sources', () => {
  it('need no token and no URL', async () => {
    const { call } = await world()
    const bad = await call('POST', '/sources', {
      kind: 'manual',
      name: 'x',
      baseUrl: 'https://a.example.com',
    })
    expect(bad.status).toBe(400)
    const tokenBad = await call('POST', '/sources', {
      kind: 'manual',
      name: 'y',
      token: 'secret-fictional',
    })
    expect(tokenBad.status).toBe(400)
  })

  it('refuse a connection test', async () => {
    const { call, sourceId } = await world()
    expect((await call('POST', `/sources/${sourceId}/test`, {})).status).toBe(400)
  })
})

describe('POST /api/deployments', () => {
  it('stores an entry, maps its repo and defaults the reach from the domains', async () => {
    const { call, sourceId, repos } = await world()
    const res = await call('POST', '/deployments', { sourceId, ...ENTRY })
    expect(res.status).toBe(201)
    const item = deploymentItemSchema.parse(res.json)
    expect(item).toMatchObject({
      name: 'partner-portal',
      reach: 'public',
      domains: ['https://portal.example.com'],
      gitRepository: 'example-org/portal',
      mapping: 'auto',
    })
    const row = repos.deployments.get(item.id)!
    expect(row.facts?.gaps.user).toBeTruthy()
    expect(row.status).toBe('unknown')
  })

  it('defaults the reach to unknown without an http domain and keeps a named one', async () => {
    const { call, sourceId } = await world()
    const a = deploymentItemSchema.parse(
      (await call('POST', '/deployments', { sourceId, name: 'a', domains: ['a.example.com'] }))
        .json,
    )
    expect(a.reach).toBe('unknown')
    expect(a.coverage.imageOnly).toBe(true)
    const b = deploymentItemSchema.parse(
      (await call('POST', '/deployments', { sourceId, name: 'b', reach: 'internal' })).json,
    )
    expect(b.reach).toBe('internal')
  })

  it('refuses unknown keys, bad repos, duplicate names and other kinds of source', async () => {
    const { call, sourceId, repos } = await world()
    expect((await call('POST', '/deployments', { sourceId, name: 'a', extra: 1 })).status).toBe(400)
    expect((await call('POST', '/deployments', { sourceId, name: 'a', repo: 'no' })).status).toBe(
      400,
    )
    await call('POST', '/deployments', { sourceId, name: 'Dup' })
    expect((await call('POST', '/deployments', { sourceId, name: 'dup' })).status).toBe(409)
    const coolify = repos.sources.create({
      kind: 'coolify',
      name: 'edge',
      baseUrl: 'https://coolify.example.dev',
      token: 'coolify-fictional',
    })
    expect((await call('POST', '/deployments', { sourceId: coolify.id, name: 'a' })).status).toBe(
      400,
    )
  })
})

describe('PATCH and DELETE /api/deployments/:id', () => {
  it('edits fields, clears optional ones and removes the entry', async () => {
    const { call, sourceId, repos } = await world()
    const made = deploymentItemSchema.parse(
      (await call('POST', '/deployments', { sourceId, ...ENTRY })).json,
    )
    const patched = deploymentItemSchema.parse(
      (
        await call('PATCH', `/deployments/${made.id}`, {
          branch: null,
          reach: 'internal',
          repo: null,
        })
      ).json,
    )
    expect(patched).toMatchObject({
      gitBranch: null,
      reach: 'internal',
      gitRepository: null,
      image: ENTRY.image,
    })
    expect((await call('PATCH', `/deployments/${made.id}`, {})).status).toBe(400)
    expect((await call('DELETE', `/deployments/${made.id}`)).status).toBe(204)
    expect(repos.deployments.get(made.id)).toBeUndefined()
  })

  it('leaves deployments of other sources alone', async () => {
    const { call, repos } = await world()
    const coolify = repos.sources.create({
      kind: 'coolify',
      name: 'edge',
      baseUrl: 'https://coolify.example.dev',
      token: 'coolify-fictional',
    })
    const row = repos.deployments.upsert({
      sourceId: coolify.id,
      externalId: 'a',
      kind: 'application',
      name: 'x',
    })
    expect((await call('DELETE', `/deployments/${row.id}`)).status).toBe(400)
    expect((await call('PATCH', `/deployments/${row.id}`, { name: 'y' })).status).toBe(400)
  })
})

describe('POST /api/deployments/import', () => {
  const yaml = (extra = '') =>
    `deployments:\n  - name: one\n    repo: example-org/one\n  - name: two\n    domains: [https://two.example.com]\n${extra}`

  it('adds new entries, updates the ones it names and can remove the rest', async () => {
    const { call, sourceId } = await world()
    await call('POST', '/deployments', { sourceId, name: 'old' })
    const first = importManualDeploymentsResponseSchema.parse(
      (await call('POST', '/deployments/import', { sourceId, yaml: yaml() })).json,
    )
    expect(first).toEqual({ created: 2, updated: 0, removed: 0 })
    const again = importManualDeploymentsResponseSchema.parse(
      (await call('POST', '/deployments/import', { sourceId, yaml: yaml(), replace: true })).json,
    )
    expect(again).toEqual({ created: 0, updated: 2, removed: 1 })
  })

  it('rejects unknown keys, aliases, duplicates and broken YAML with a reason', async () => {
    const { call, sourceId } = await world()
    const post = (text: string) => call('POST', '/deployments/import', { sourceId, yaml: text })
    const typo = await post('deployments:\n  - name: a\n    typo: 1\n')
    expect(typo.status).toBe(400)
    expect(typo.text).toContain('entry 1 (a)')
    expect((await post('deployments:\n  - &x {name: a}\n  - *x\n')).status).toBe(400)
    expect((await post('deployments:\n  - name: a\n  - name: A\n')).status).toBe(400)
    expect((await post('deployments: [')).status).toBe(400)
    expect((await post('other: 1')).status).toBe(400)
    expect(
      (await call('POST', '/deployments/import', { sourceId, yaml: 'x'.repeat(50_000) })).status,
    ).toBe(400)
  })
})

describe('the scan of a manual list', () => {
  it('reads the entries back as deployments and changes nothing', async () => {
    const { call, sourceId, repos } = await world()
    const made = deploymentItemSchema.parse(
      (await call('POST', '/deployments', { sourceId, ...ENTRY })).json,
    )
    const sources = buildScanSources(repos)
    expect(sources.deployments.map((s) => s.kind)).toEqual(['manual'])
    const records = await sources.deployments[0]!.inventory()
    expect(records).toMatchObject([
      {
        externalId: expect.stringMatching(/./) as string,
        name: 'partner-portal',
        status: 'unknown',
        reach: 'public',
      },
    ])
    syncDeployments(repos, sourceId, records, new Date(nowMs()))
    const row = repos.deployments.get(made.id)!
    expect(row).toMatchObject({
      reach: 'public',
      gitRepository: 'example-org/portal',
      gitBranch: 'main',
    })
    expect(row.facts?.gaps.mounts).toBeTruthy()
  })
})
