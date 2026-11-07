import {
  findingDetailSchema,
  fixesResponseSchema,
  fixPlanSchema,
  fixPlansResponseSchema,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { saveScanPlans } from '../scan/index.js'
import { createTestApi, seedFixWorld } from './testing.js'

// GET /api/repos/:id/plan and GET /api/plans. Every name is fictional (seedFixWorld).

const T0 = new Date('2026-11-02T06:00:00.000Z')

/** Runs the plan step of a scan for the given repos, as if OSV was off. */
function planScan(repos: Repositories, scanned: RepoRow[]) {
  const run = repos.scanRuns.start('manual', T0)
  const skipped = { status: 'skipped', reason: 'off' } as const
  const scans = new Map(
    scanned.map((repo) => [
      repo.id,
      { repo, deployed: true, health: skipped, alerts: skipped, osv: skipped },
    ]),
  )
  saveScanPlans(repos, run.id, scans, T0)
  return run.id
}

describe('GET /api/repos/:id/plan', () => {
  it('answers 404 until a scan built a plan, and for an unknown repo', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    expect((await call('GET', `/repos/${world.storefront.id}/plan`)).status).toBe(404)
    expect((await call('GET', '/repos/9999/plan')).status).toBe(404)
  })

  it('serves the latest plan, or the plan of one scan', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    const first = planScan(repos, [world.storefront, world.ledger])
    const second = planScan(repos, [world.storefront])

    const res = await call('GET', `/repos/${world.storefront.id}/plan`)
    expect(res.status).toBe(200)
    const plan = fixPlanSchema.parse(res.json)
    expect(plan).toMatchObject({ version: 1, scanRunId: second })
    expect(plan.repo.fullName).toBe('kestrel-co/storefront')
    expect(plan.steps.map((s) => [s.packageName, s.to])).toEqual([
      ['kestrel-http', '2.1.0'],
      ['tiny-glob', '1.10.0'],
    ])
    expect(plan.unfixed.map((u) => u.packageName)).toEqual(['pad-ng'])
    expect(plan.previous).toEqual({ scanRunId: first, findings: 5, cleared: 0, stillOpen: 5 })

    const older = fixPlanSchema.parse(
      (await call('GET', `/repos/${world.storefront.id}/plan?scan=${first}`)).json,
    )
    expect(older.scanRunId).toBe(first)
    expect((await call('GET', `/repos/${world.docs.id}/plan?scan=${first}`)).status).toBe(404)
    expect((await call('GET', `/repos/${world.storefront.id}/plan?scan=abc`)).status).toBe(400)
  })
})

describe('GET /api/plans', () => {
  it('lists the latest plan summary per repo, most findings cleared first', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    planScan(repos, [world.storefront, world.ledger, world.docs])
    const { items } = fixPlansResponseSchema.parse((await call('GET', '/plans')).json)
    expect(items.map((p) => [p.repo.name, p.summary.findings.cleared])).toEqual([
      ['storefront', 5],
      ['ledger', 2],
      ['docs', 1],
    ])
  })
})

describe('plan links', () => {
  it('links each repo of a fix and the finding detail to the latest plan', async () => {
    const { call, repos } = createTestApi()
    const world = seedFixWorld(repos)
    const before = fixesResponseSchema.parse((await call('GET', '/fixes')).json)
    expect(before.items[0]?.repos.every((r) => r.plan === null)).toBe(true)

    const run = planScan(repos, [world.storefront, world.ledger])
    const { items } = fixesResponseSchema.parse((await call('GET', '/fixes')).json)
    const plans = Object.fromEntries(
      items[0]!.repos.map((r) => [r.repo.name, r.plan?.scanRunId ?? null]),
    )
    expect(plans).toEqual({ storefront: run, ledger: run, docs: null })

    const detail = findingDetailSchema.parse(
      (await call('GET', `/findings/${world.findings.httpCriticalStorefront.id}`)).json,
    )
    expect(detail.plan).toMatchObject({ repoId: world.storefront.id, scanRunId: run })
    // The seeded findings name no lockfile or version, so both steps need a person.
    expect(detail.plan?.summary.steps).toEqual({ safe: 0, risky: 2 })
  })
})
