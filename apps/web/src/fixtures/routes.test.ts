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
  repoDetailSchema,
  runnerStatusSchema,
  type RunnerStatus,
  scanRunSchema,
  scanStatusSchema,
  scansResponseSchema,
  githubWebhookSettingsSchema,
  checkOverridesResponseSchema,
  GUARD_CHECKS,
  GUARD_COPY,
  guardsResponseSchema,
  rotateWebhookRunnerSecretResponseSchema,
  webhookRunnerSettingsSchema,
  rotateGithubWebhookSecretResponseSchema,
  settingsSchema,
  versionResponseSchema,
  sourcesResponseSchema,
  FIX_RUN_DEPLOY_STATUSES,
  FIX_RUN_VERIFY_AFTER,
  FIX_RUN_VERIFY_STATUSES,
  FIX_RUN_WARNING_CODES,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { DEPLOYMENTS, FINDINGS, LAST_SCAN, SOURCES } from './dataset'
import { ALL_REPOS } from './repo-sources'
import { PLANS, RUNS } from './fix-runs'
import { WEBHOOK_SCENARIOS } from './webhook'
import { RUNNER_SCENARIOS } from './webhook-runner'
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
    ['/version', versionResponseSchema],
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
    ['/guards', guardsResponseSchema],
    ['/overrides', checkOverridesResponseSchema],
    ['/findings?kind=guard&check=root_user,docker_socket&level=fail', findingsResponseSchema],
  ]

  it.each(routes)('answers %s in the contract shape', (path, schema) => {
    expectShape(path, schema)
    expectShape(path, schema, 'setup')
  })

  it('shows a fixed version, and a newer release only in the update scenario', () => {
    const version = (scenario?: FixtureScenario) =>
      versionResponseSchema.parse(get('/version', scenario).body)
    expect(version()).toMatchObject({ version: '0.3.0', isDev: false, update: null })
    expect(version('update').update?.version).toBe('0.3.1')
    expectShape('/version', versionResponseSchema, 'update')
  })

  it('answers every repo with the GitHub source that reads it', () => {
    const github = SOURCES.filter((s) => s.kind === 'github')
    expect(github.length).toBeGreaterThan(1)
    const reads = new Map<number, number>()
    for (const repo of ALL_REPOS) {
      expectShape(`/repos/${repo.id}`, repoDetailSchema)
      const { source } = repoDetailSchema.parse(get(`/repos/${repo.id}`).body)
      const current = source.current?.id ?? 0
      reads.set(current, (reads.get(current) ?? 0) + 1)
      expect(source.seenBy.map((s) => s.id)).toContain(current)
    }
    // The counts on Settings, Sources match the repos each source reads.
    for (const s of github) expect(reads.get(s.id) ?? 0, s.name).toBe(s.repoCount)
    expect(get('/repos/9999').status).toBe(404)
  })

  it.each(WEBHOOK_SCENARIOS)('answers the webhook settings in the %s scenario', (scenario) => {
    expectShape('/settings/github-webhook', githubWebhookSettingsSchema, scenario)
    expect(get('/settings', scenario).status).toBe(200)
  })

  it.each(RUNNER_SCENARIOS)(
    'answers the runner settings and statuses in the %s scenario',
    (scenario) => {
      expectShape('/settings/webhook-runner', webhookRunnerSettingsSchema, scenario)
      for (const plan of PLANS) {
        expectShape(`/repos/${plan.repo.id}/runner`, runnerStatusSchema, scenario)
      }
    },
  )

  it('shapes the runner kinds by what the host offers', () => {
    const status = (id: number, scenario?: FixtureScenario) =>
      get(`/repos/${id}/runner`, scenario).body as RunnerStatus
    // Webhook: ready when set up, not ready (with the reason) when it is not.
    expect(status(20).settings.kind).toBe('webhook')
    expect(status(20).ready).toBe(true)
    expect(status(20, 'runner-new').ready).toBe(false)
    expect(status(20, 'runner-new').message).toMatch(/Set the webhook runner URL/)
    expect(status(20, 'runner-new').runners?.webhook.configured).toBe(false)
    // A webhook repo whose runner is off needs turning on, whatever the host offers.
    expect(status(21).settings.enabled).toBe(false)
    expect(status(21).ready).toBe(false)
    // Local: available by default, off on a host without it, with the warning either way.
    expect(status(22).settings.kind).toBe('local')
    expect(status(22).ready).toBe(true)
    expect(status(22).runners?.local?.available).toBe(true)
    expect(status(22, 'local-off').ready).toBe(false)
    expect(status(22, 'local-off').runners?.local?.available).toBe(false)
    for (const scenario of ['default', 'local-off'] as const) {
      expect(status(1, scenario).runners?.local?.warning).toMatch(/dedicated container/)
    }
    expect(status(1).settings.kind).toBe('github_actions')
  })

  it('has webhook and local runs without a workflow run', () => {
    const other = RUNS.filter((r) => r.runner !== 'github_actions')
    expect(new Set(other.map((r) => r.runner))).toEqual(new Set(['webhook', 'local']))
    for (const run of other) expect(run.github).toBeNull()
  })

  it('answers a new runner secret once, in the contract shape', () => {
    const reply = fixtureRoute(
      'POST',
      new URL('http://localhost/api/settings/webhook-runner/secret'),
      'runner-new',
    )
    expect(reply.status).toBe(201)
    expect(rotateWebhookRunnerSecretResponseSchema.safeParse(reply.body).error).toBeUndefined()
  })

  it('answers a new webhook secret once, in the contract shape', () => {
    const reply = fixtureRoute(
      'POST',
      new URL('http://localhost/api/settings/github-webhook/secret'),
      'webhook-new',
    )
    expect(rotateGithubWebhookSecretResponseSchema.safeParse(reply.body).error).toBeUndefined()
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

  it('covers the majors agent: off, on without the secret, on with it, and each majors run', () => {
    const runner = (id: number) => get(`/repos/${id}/runner`).body as RunnerStatus
    expect(runner(1).settings.majorsAgent).toBe('off')
    expect(runner(17).settings.majorsAgent).toBe('claude-code')
    expect(runner(17).caller.passesAgentSecret).toBe(false)
    expect(runner(18).settings.majorsAgent).toBe('claude-code')
    expect(runner(18).caller.passesAgentSecret).toBe(true)
    const majors = RUNS.filter((r) => r.kind === 'majors')
    expect(majors.map((r) => [r.state, r.pr?.draft ?? null, r.result?.agent?.outcome])).toEqual([
      ['running', null, undefined],
      ['pr_open', true, 'changed'],
      ['failed', null, 'timeout'],
    ])
    // The plan of the majors-only repo has no safe step; the others have one beside the majors.
    expect(PLANS.find((p) => p.repo.id === 16)?.summary.steps.safe).toBe(0)
    expect(PLANS.find((p) => p.repo.id === 18)?.summary.steps.safe).toBe(1)
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

  it('keeps the release tier mode a PUT sets and moves the repo in and out of the tier', () => {
    const put = (id: number, tier: unknown) =>
      fixtureRoute('PUT', new URL(`http://localhost/api/repos/${id}/release-tier`), 'default', {
        tier,
      })
    const desk = ALL_REPOS.find((r) => r.name === 'kestrel-desk')!
    const release = (reply: { body?: unknown }) => repoDetailSchema.parse(reply.body).release
    expect(release(get(`/repos/${desk.id}`))).toMatchObject({ tier: 'auto', status: 'released' })
    expect(release(put(desk.id, 'off'))).toMatchObject({ tier: 'off', status: 'turned_off' })
    expect(release(get(`/repos/${desk.id}`)).tier).toBe('off')
    expect(release(put(desk.id, 'auto'))).toMatchObject({ tier: 'auto', status: 'released' })
    expect(put(desk.id, 'sometimes').status).toBe(403)
    expect(put(9999, 'on').status).toBe(404)
    // A repo a deployment runs is never asked for its release.
    expect(release(get('/repos/1')).status).toBe('deployed')
  })

  it('serves release findings in the released tier, one fixed on the default branch', () => {
    const rows = FINDINGS.filter((f) => f.releaseTag !== null)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((f) => f.tier === 'released')).toBe(true)
    expect(rows.some((f) => f.fixedOnDefaultBranch)).toBe(true)
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

  it('has a guard finding for every level each check can report, some turned off', () => {
    const guards = FINDINGS.filter((f) => f.guard)
    for (const check of GUARD_CHECKS) {
      for (const level of GUARD_COPY[check].levels) {
        expect(
          guards.some((f) => f.guard!.check === check && f.guard!.level === level),
          `${check} ${level}`,
        ).toBe(true)
      }
    }
    const off = guards.filter((f) => f.guard!.override)
    expect(off.length).toBeGreaterThan(0)
    expect(off.every((f) => f.state === 'accepted')).toBe(true)
  })

  it('filters guard findings on check and level, and findings on a release', () => {
    const roots = filterFindings(new URLSearchParams('kind=guard&check=root_user&level=fail'))
    expect(roots.items.length).toBeGreaterThan(0)
    expect(
      roots.items.every((f) => f.guard?.check === 'root_user' && f.guard.level === 'fail'),
    ).toBe(true)
    const released = filterFindings(new URLSearchParams('release=true'))
    expect(released.items.every((f) => f.releaseTag !== null)).toBe(true)
  })

  it('filters findings like the server', () => {
    const exposed = filterFindings(new URLSearchParams('tier=exposed&state=open'))
    expect(exposed.items.every((f) => f.tier === 'exposed' && f.state === 'open')).toBe(true)
    expect(exposed.total).toBe(exposed.items.length)
    const tessera = filterFindings(new URLSearchParams('q=tessera'))
    expect(tessera.items.map((f) => f.id)).toEqual([1, 7])
  })
})
