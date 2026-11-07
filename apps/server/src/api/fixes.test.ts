import {
  findingDetailSchema,
  fixesResponseSchema,
  overviewResponseSchema,
  currentTime,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createTestApi, seedFixWorld } from './testing.js'

// GET /api/fixes (#51). Every name and domain is fictional.

async function getFixes(call: ReturnType<typeof createTestApi>['call'], query = '') {
  const res = await call('GET', `/fixes${query}`)
  expect(res.status).toBe(200)
  return fixesResponseSchema.parse(res.json)
}

describe('GET /api/fixes', () => {
  it('lists fixes with counts, repos and the best tier', async () => {
    const { call, repos } = createTestApi()
    seedFixWorld(repos)
    const { items, total, nextOffset } = await getFixes(call)
    expect(total).toBe(4)
    expect(nextOffset).toBeNull()
    const http = items[0]!
    expect(http).toMatchObject({
      key: 'npm:kestrel-http:2.1.0',
      target: '2.1.0',
      mixedTargets: true,
      bestTier: 'exposed',
      exposedCritical: true,
    })
    expect(http.findings.total).toBe(5)
    expect(http.findings.bySeverity).toEqual({ critical: 2, high: 1, moderate: 2, low: 0 })
    expect(http.findings.byTier).toMatchObject({ exposed: 2, internal: 1, not_deployed: 1 })
    expect(http.findingIds).toHaveLength(5)
    expect(http.repos.map((r) => [r.repo.fullName, r.target])).toEqual([
      ['kestrel-co/storefront', '2.1.0'],
      ['kestrel-co/docs', '2.0.4'],
      ['kestrel-co/ledger', '2.0.1'],
    ])
    expect(http.apps.map((a) => a.name)).toEqual(['ledger-api', 'storefront-web'])
  })

  it('serves the package without a patch as its own fix with a null target', async () => {
    const { call, repos } = createTestApi()
    seedFixWorld(repos)
    const { items } = await getFixes(call)
    const pad = items.find((f) => f.packageName === 'pad-ng')
    expect(pad).toMatchObject({ target: null, key: 'npm:pad-ng:none', exposedCritical: true })
  })

  it('leaves out excluded states', async () => {
    const { call, repos } = createTestApi()
    seedFixWorld(repos)
    const { items } = await getFixes(call)
    expect(items.map((f) => f.packageName)).not.toContain('xml-lite')
    expect(items.reduce((sum, f) => sum + f.findings.total, 0)).toBe(9)
  })

  it('filters by repo and by app, and the target follows the filter', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    const byRepo = await getFixes(call, `?repo=${world.ledger.id}`)
    expect(byRepo.items.map((f) => [f.packageName, f.target])).toEqual([
      ['kestrel-http', '2.0.1'],
      ['hyper-lite', '0.14.9'],
    ])
    expect(byRepo.items[0]).toMatchObject({ mixedTargets: false, exposedCritical: false })
    const byApp = await getFixes(call, `?deployment=${world.web.id}`)
    expect(byApp.items.map((f) => f.packageName)).toEqual(['kestrel-http', 'pad-ng', 'tiny-glob'])
    const none = await getFixes(
      call,
      `?repo=${world.docs.id},${world.ledger.id}&deployment=${world.web.id}`,
    )
    expect(none.items).toEqual([])
  })

  it('pages the result', async () => {
    const { call, repos } = createTestApi()
    seedFixWorld(repos)
    const first = await getFixes(call, '?limit=3')
    expect(first.items).toHaveLength(3)
    expect(first.nextOffset).toBe(3)
    const second = await getFixes(call, '?limit=3&offset=3')
    expect(second.items).toHaveLength(1)
    expect(second.nextOffset).toBeNull()
    expect(second.total).toBe(4)
  })

  it('is empty without findings and rejects bad queries', async () => {
    const { call } = createTestApi()
    expect(await getFixes(call)).toMatchObject({ items: [], total: 0, nextOffset: null })
    expect((await call('GET', '/fixes?limit=0')).status).toBe(400)
    expect((await call('GET', '/fixes?repo=abc')).status).toBe(400)
    expect((await call('GET', '/fixes?tier=exposed')).status).toBe(400)
  })
})

describe('overview topFixes', () => {
  it('lists the fixes with a patch, best first, at most five', async () => {
    const { call, repos } = createTestApi()
    seedFixWorld(repos)
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.topFixes.map((f) => `${f.packageName}@${f.target}`)).toEqual([
      'kestrel-http@2.1.0',
      'tiny-glob@1.10.0',
      'hyper-lite@0.14.9',
    ])
  })

  it('caps the list at five', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    for (let i = 0; i < 4; i++) {
      const advisory = repos.advisories.upsert({
        advisoryKey: `GHSA-extra-aaaa-000${i}`,
        ecosystem: 'npm',
        packageName: `kestrel-extra-${i}`,
        severity: 'moderate',
        firstPatchedVersion: '1.0.1',
      })
      repos.findings.observe(
        { kind: 'advisory', advisoryId: advisory.id, repoId: world.ledger.id, reportedBy: ['osv'] },
        currentTime(),
      )
    }
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.topFixes).toHaveLength(5)
  })

  it('is empty when nothing needs a bump', async () => {
    const { call } = createTestApi()
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.topFixes).toEqual([])
  })
})

describe('finding detail sameFixClears', () => {
  async function clears(
    call: ReturnType<typeof createTestApi>['call'],
    id: number,
  ): Promise<number> {
    return findingDetailSchema.parse((await call('GET', `/findings/${id}`)).json).sameFixClears
  }

  it('counts the open findings the same bump clears, itself included', async () => {
    const { call, repos } = createTestApi()
    const { findings } = seedFixWorld(repos)
    expect(await clears(call, findings.httpCriticalLedger.id)).toBe(5)
    expect(await clears(call, findings.globNewStorefront.id)).toBe(2)
    expect(await clears(call, findings.hyperLedger.id)).toBe(1)
  })

  it('counts the no patch group for a finding without a patch', async () => {
    const { call, repos } = createTestApi()
    const { findings } = seedFixWorld(repos)
    expect(await clears(call, findings.padStorefront.id)).toBe(1)
  })

  it('is 0 for findings that are not part of a fix', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    const { findings } = world
    for (const id of [
      findings.xmlSnoozed.id,
      findings.xmlDismissed.id,
      findings.xmlFixed.id,
      findings.hyperStaleLedger.id,
      world.blind.id,
      world.coverage.id,
    ]) {
      expect(await clears(call, id)).toBe(0)
    }
  })

  it('drops when a sibling is snoozed', async () => {
    const { call, repos } = createTestApi()
    const { findings } = seedFixWorld(repos)
    repos.findings.changeState(findings.httpModerateDocs.id, { state: 'snoozed', actor: 'user' })
    expect(await clears(call, findings.httpCriticalLedger.id)).toBe(4)
  })
})
