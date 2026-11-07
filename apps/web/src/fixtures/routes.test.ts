import {
  accessStatusSchema,
  deploymentDeploysResponseSchema,
  deploymentDetailSchema,
  deploymentsResponseSchema,
  findingDetailSchema,
  findingsResponseSchema,
  fixesResponseSchema,
  fixPlanSchema,
  fixPlansResponseSchema,
  fixRunDetailSchema,
  FIX_RUN_STATES,
  fixRunsResponseSchema,
  healthResponseSchema,
  navCountsSchema,
  notifyChannelsResponseSchema,
  notifySettingsSchema,
  onboardingStateSchema,
  overviewResponseSchema,
  reposResponseSchema,
  runnerStatusSchema,
  scanRunSchema,
  scanStatusSchema,
  scansResponseSchema,
  settingsSchema,
  sourcesResponseSchema,
  FIX_RUN_DEPLOY_STATUSES,
  FIX_RUN_VERIFY_AFTER,
  FIX_RUN_VERIFY_STATUSES,
  FIX_RUN_WARNING_CODES,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { DEPLOYMENTS, FINDINGS, LAST_SCAN } from './dataset'
import { PLANS, RUNS } from './fix-runs'
import { filterFindings, fixtureRoute, type FixtureScenario } from './routes'

const get = (path: string, scenario?: FixtureScenario) =>
  fixtureRoute('GET', new URL(`http://localhost/api${path}`), scenario)

function expectShape(path: string, schema: z.ZodType, scenario?: FixtureScenario) {
  const reply = get(path, scenario)
  expect(reply.status, path).toBe(200)
  const parsed = schema.safeParse(reply.body)
  expect(parsed.error, path).toBeUndefined()
}

// Fixture mode feeds the real views, so every answer has to match the shared API contract.
describe('fixture API', () => {
  const routes: [string, z.ZodType][] = [
    ['/health', healthResponseSchema],
    ['/access', accessStatusSchema],
    ['/onboarding', onboardingStateSchema],
    ['/shell/nav-counts', navCountsSchema],
    ['/shell/scan-status', scanStatusSchema],
    ['/overview', overviewResponseSchema],
    ['/findings', findingsResponseSchema],
    ['/findings?tier=exposed,blind_spot&state=open&group=tier', findingsResponseSchema],
    ['/fixes?limit=25', fixesResponseSchema],
    ['/deployments', deploymentsResponseSchema],
    ['/repos', reposResponseSchema],
    ['/sources', sourcesResponseSchema],
    ['/settings', settingsSchema],
    ['/scans?limit=1', scansResponseSchema],
    [`/scans/${LAST_SCAN.id}`, scanRunSchema],
    ['/notifications/channels', notifyChannelsResponseSchema],
    ['/notifications/settings', notifySettingsSchema],
    ['/plans', fixPlansResponseSchema],
  ]

  it.each(routes)('answers %s in the contract shape', (path, schema) => {
    expectShape(path, schema)
    expectShape(path, schema, 'setup')
  })

  it('answers every finding and deployment detail in the contract shape', () => {
    for (const f of FINDINGS) expectShape(`/findings/${f.id}`, findingDetailSchema)
    for (const d of DEPLOYMENTS) {
      expectShape(`/deployments/${d.id}`, deploymentDetailSchema)
      expectShape(`/deployments/${d.id}/deploys?limit=8`, deploymentDeploysResponseSchema)
    }
  })

  it('answers every plan, runner status and fix run in the contract shape', () => {
    for (const plan of PLANS) {
      const id = plan.repo.id
      expectShape(`/repos/${id}/plan`, fixPlanSchema)
      expectShape(`/repos/${id}/runner`, runnerStatusSchema)
      expectShape(`/repos/${id}/fix-runs?limit=20`, fixRunsResponseSchema)
    }
    for (const run of RUNS) {
      expectShape(`/fix-runs/${run.id}`, fixRunDetailSchema)
    }
  })

  it('shows every deploy status, warning and verification state on some run', () => {
    const deploys = RUNS.flatMap((r) => r.deployments)
    const verifications = RUNS.flatMap((r) => (r.verification ? [r.verification] : []))
    expect(new Set(deploys.map((d) => d.status))).toEqual(new Set(FIX_RUN_DEPLOY_STATUSES))
    expect(new Set(RUNS.flatMap((r) => r.warnings.map((w) => w.code)))).toEqual(
      new Set(FIX_RUN_WARNING_CODES),
    )
    expect(new Set(verifications.map((v) => v.after))).toEqual(new Set(FIX_RUN_VERIFY_AFTER))
    // `pending` lasts only until the next tracker tick, so no fixture run waits in it.
    expect(new Set(verifications.map((v) => v.status))).toEqual(
      new Set(FIX_RUN_VERIFY_STATUSES.filter((s) => s !== 'pending')),
    )
    // The links in the run detail land on fixture apps and findings.
    for (const d of deploys) {
      expect(DEPLOYMENTS.some((app) => app.id === d.deploymentId)).toBe(true)
    }
    for (const id of verifications.flatMap((v) => [...v.stillOpen, ...v.new])) {
      expect(FINDINGS.some((f) => f.id === id)).toBe(true)
    }
  })

  it('has a fix run in every state', () => {
    expect(new Set(RUNS.map((r) => r.state))).toEqual(new Set(FIX_RUN_STATES))
  })

  it('asks before reopening a closed fix PR and refuses every other dispatch', () => {
    const post = (path: string, body?: unknown) =>
      fixtureRoute('POST', new URL(`http://localhost/api${path}`), 'default', body)
    const ask = post('/repos/7/fix-runs', {})
    expect(ask.status).toBe(409)
    expect(ask.body).toMatchObject({ previous: { pr: { number: 118 } } })
    expect(post('/repos/7/fix-runs', { confirmReopen: true }).status).toBe(403)
    expect(post('/repos/1/fix-runs', {}).status).toBe(403)
  })

  it('refuses writes and unknown paths', () => {
    expect(fixtureRoute('POST', new URL('http://localhost/api/scans')).status).toBe(403)
    expect(get('/findings/999').status).toBe(404)
    expect(get('/nothing').status).toBe(404)
  })

  it('opens setup on the GitHub step in the setup scenario', () => {
    expect(get('/onboarding', 'setup').body).toEqual({ finished: false, alertsSkipped: false })
    const sources = get('/sources', 'setup').body as z.infer<typeof sourcesResponseSchema>
    expect(sources.sources.map((s) => s.kind)).toEqual(['coolify'])
  })

  it('filters findings like the server', () => {
    const exposed = filterFindings(new URLSearchParams('tier=exposed&state=open'))
    expect(exposed.items.every((f) => f.tier === 'exposed' && f.state === 'open')).toBe(true)
    expect(exposed.total).toBe(exposed.items.length)
    const tessera = filterFindings(new URLSearchParams('q=tessera'))
    expect(tessera.items.map((f) => f.id)).toEqual([1, 7])
  })
})
