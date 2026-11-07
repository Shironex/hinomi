import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { DeploymentRow, FixPlanRow, FixRunRow, RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import type { RepoRescanOutcome, RepoRescanner } from './tracker-verify.js'
import { createFixRunTracker, type FixRunTrackerOptions } from './tracker.js'
import {
  connectGithubToken,
  fakeGithub,
  runnerResult,
  saveRunnerPlan,
  type FakeReply,
} from './testing.js'
import { trackingPhase } from './tracking.js'

// Linking merged fix runs to Coolify deploys and verifying them by a rescan, against a fake
// GitHub compare API and a fake Coolify. Every org, app, host and commit here is fictional.

const T0 = new Date('2026-11-07T12:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const API = '/repos/kestrel-co/harbor'
const MERGE = 'e'.repeat(40)
const LATER = 'f'.repeat(40)
const OLDER = 'd'.repeat(40)
const COOLIFY = 'https://coolify.example.dev'

interface FakeDeploy {
  deployment_uuid: string
  status: string
  commit: string | null
  created_at: string
  finished_at: string | null
  rollback?: boolean
}

let repos: Repositories
let handle: DatabaseHandle
let harbor: RepoRow
let plan: FixPlanRow
let coolifyId: number
let clock: Date
/** Deploys per Coolify app uuid, newest first. */
let deploys: Record<string, FakeDeploy[]>
/** Compare answers by head commit. */
let compare: Record<string, FakeReply>

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  connectGithubToken(repos)
  coolifyId = repos.sources.create({
    kind: 'coolify',
    name: 'edge',
    baseUrl: COOLIFY,
    token: 'coolify-token-fictional-0001',
  }).id
  // Findings 1 and 2 are the safe steps' targets, 3 the risky step's (runnerPlan).
  for (const name of ['plover-parse', 'heron-ui', 'egret-db']) {
    const advisory = repos.advisories.upsert({
      advisoryKey: `GHSA-${name}`,
      ghsaId: `GHSA-${name}`,
      ecosystem: 'npm',
      packageName: name,
      severity: 'high',
    })
    repos.findings.observe(
      { kind: 'advisory', advisoryId: advisory.id, repoId: harbor.id, reportedBy: ['github'] },
      T0,
    )
  }
  plan = saveRunnerPlan(repos, harbor, T0)
  clock = T0
  deploys = {}
  compare = {}
})
afterEach(() => handle.close())

function app(
  externalId: string,
  overrides: Partial<{ gitBranch: string | null; watchPaths: string[] | null; name: string }> = {},
): DeploymentRow {
  return repos.deployments.upsert(
    {
      sourceId: coolifyId,
      externalId,
      kind: 'application',
      name: overrides.name ?? `harbor-${externalId}`,
      domains: [],
      reach: 'internal',
      server: 'edge-1',
      status: 'running:healthy',
      gitRepository: 'kestrel-co/harbor',
      gitBranch: overrides.gitBranch === undefined ? 'main' : overrides.gitBranch,
      watchPaths: overrides.watchPaths ?? null,
      repoId: harbor.id,
    },
    T0,
  )
}

function deploy(id: string, commit: string, finishedAt: Date, status = 'finished'): FakeDeploy {
  return {
    deployment_uuid: id,
    status,
    commit,
    created_at: new Date(finishedAt.getTime() - MINUTE).toISOString(),
    finished_at: finishedAt.toISOString(),
  }
}

function world() {
  return fakeGithub([
    {
      path: /^\/repos\/kestrel-co\/harbor\/compare\//,
      reply: (request) => {
        const head = request.path.split('...')[1]?.split('?')[0] ?? ''
        return compare[head] ?? { status: 404, body: { message: 'Not Found' } }
      },
    },
    {
      path: /^\/api\/v1\/deployments\/applications\//,
      reply: (request) => {
        const uuid = request.path.split('/').pop()?.split('?')[0] ?? ''
        return { body: deploys[uuid] ?? [] }
      },
    },
  ])
}

/** A fix run whose PR merged at T0 with MERGE, with its result stored. */
function merged(): FixRunRow {
  const { run } = repos.fixRuns.create(
    {
      repoId: harbor.id,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
      runner: 'github_actions',
      kind: 'fix',
      correlationId: 'corr-1',
      checksMode: 'full',
    },
    T0,
  )
  repos.fixRuns.setResult(run.id, runnerResult(plan.plan, 'corr-1', { repo: 'kestrel-co/harbor' }))
  const events = [
    { type: 'dispatch_accepted' as const, githubRunId: 9001 },
    {
      type: 'pr_opened' as const,
      number: 40,
      url: 'https://github.com/kestrel-co/harbor/pull/40',
      draft: false,
    },
    { type: 'pr_merged' as const, mergeSha: MERGE },
  ]
  for (const event of events) {
    const applied = repos.fixRuns.applyEvent(run.id, event, T0)
    if (!applied.ok) throw new Error(applied.rejection.message)
  }
  return get(run)
}

/** A rescanner that fixes the given findings and reports what changed. */
function rescanFixing(fixed: number[], opened: number[] = []) {
  const calls: number[] = []
  const rescan: RepoRescanner = (repoId) => {
    calls.push(repoId)
    for (const id of fixed) {
      repos.findings.changeState(id, { state: 'fixed', actor: 'system', eventType: 'fixed' }, clock)
    }
    return Promise.resolve<RepoRescanOutcome>({
      kind: 'done',
      at: clock,
      changes: [
        ...fixed.map((findingId) => ({ findingId, change: 'fixed' })),
        ...opened.map((findingId) => ({ findingId, change: 'opened' })),
      ],
    })
  }
  return { rescan, calls }
}

function tracker(extra: Partial<FixRunTrackerOptions> = {}) {
  const fake = world()
  const t = createFixRunTracker({
    repositories: repos,
    fetch: fake.fetch,
    now: () => clock,
    ...extra,
  })
  return { tracker: t, requests: fake.requests }
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms)
}

function get(run: { id: number }): FixRunRow {
  const row = repos.fixRuns.get(run.id)
  if (!row) throw new Error('run gone')
  return row
}

const compares = (requests: { path: string }[]) =>
  requests.filter((r) => r.path.includes('/compare/'))

describe('deployment link', () => {
  it('links a deploy of a later commit that contains the merge, then verifies', async () => {
    app('app-1')
    const run = merged()
    compare[LATER] = { body: { status: 'ahead', ahead_by: 2, behind_by: 0 } }
    const { rescan, calls } = rescanFixing([1, 2])
    const { tracker: t, requests } = tracker({ rescan })

    await t.tick()
    expect(get(run).state).toBe('merged')
    expect(get(run).deployLinks).toMatchObject([{ status: 'waiting', deploy: null }])

    deploys['app-1'] = [deploy('dep-2', LATER, new Date(T0.getTime() + 5 * MINUTE))]
    advance(6 * MINUTE)
    await t.tick()
    const done = get(run)
    expect(done.state).toBe('verified')
    expect(done.deployedAt).toEqual(clock)
    expect(done.deployLinks).toMatchObject([
      {
        name: 'harbor-app-1',
        status: 'deployed',
        deploy: { id: 'dep-2', commit: LATER, relation: 'ahead' },
      },
    ])
    expect(done.verification).toMatchObject({
      after: 'deploy',
      status: 'done',
      scan: { kind: 'repo', scanRunId: null },
      targeted: [1, 2],
      cleared: [1, 2],
      stillOpen: [],
      new: [],
    })
    expect(calls).toEqual([harbor.id])
    expect(compares(requests)[0]?.path).toBe(`${API}/compare/${MERGE}...${LATER}?per_page=1`)
  })

  it('takes a deploy of the merge commit itself without asking GitHub', async () => {
    app('app-1')
    const run = merged()
    deploys['app-1'] = [deploy('dep-1', MERGE, new Date(T0.getTime() + MINUTE))]
    const { tracker: t, requests } = tracker()
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'deployed' })
    expect(get(run).deployLinks?.[0]?.deploy).toMatchObject({ relation: 'identical' })
    expect(compares(requests)).toHaveLength(0)
  })

  it('keeps waiting while deploys are behind the merge, and asks GitHub once per commit', async () => {
    app('app-1')
    const run = merged()
    deploys['app-1'] = [
      deploy('dep-old', OLDER, new Date(T0.getTime() + MINUTE)),
      deploy('dep-failed', LATER, new Date(T0.getTime() + MINUTE), 'failed'),
      deploy('dep-before', LATER, new Date(T0.getTime() - 30 * MINUTE)),
    ]
    compare[OLDER] = { body: { status: 'behind', ahead_by: 0, behind_by: 1 } }
    const { tracker: t, requests } = tracker()
    await t.tick()
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('merged')
    expect(get(run).deployLinks).toMatchObject([{ status: 'waiting', error: null }])
    // Failed and pre merge deploys are never compared; the behind answer is cached.
    expect(compares(requests).map((r) => r.path)).toEqual([
      `${API}/compare/${MERGE}...${OLDER}?per_page=1`,
    ])
  })

  it('waits for every app, ignores apps on another branch, then verifies', async () => {
    app('app-1')
    app('app-2')
    app('app-3', { gitBranch: 'staging' })
    const run = merged()
    deploys['app-1'] = [deploy('dep-1', MERGE, new Date(T0.getTime() + MINUTE))]
    const { rescan, calls } = rescanFixing([1, 2])
    const { tracker: t } = tracker({ rescan })

    await t.tick()
    expect(get(run).state).toBe('deployed')
    expect(get(run).deployLinks?.map((l) => [l.name, l.status])).toEqual([
      ['harbor-app-1', 'deployed'],
      ['harbor-app-2', 'waiting'],
      ['harbor-app-3', 'other_branch'],
    ])
    expect(trackingPhase(get(run), clock)).toBe('deploy')
    expect(calls).toEqual([])

    deploys['app-2'] = [deploy('dep-2', MERGE, new Date(T0.getTime() + 3 * MINUTE))]
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('verified')
    expect(get(run).deployLinks?.filter((l) => l.status === 'deployed')).toHaveLength(2)
  })

  it('verifies once the other apps had an hour to deploy', async () => {
    app('app-1')
    app('app-2')
    const run = merged()
    deploys['app-1'] = [deploy('dep-1', MERGE, new Date(T0.getTime() + MINUTE))]
    const { rescan } = rescanFixing([1, 2])
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    advance(61 * MINUTE)
    expect(trackingPhase(get(run), clock)).toBe('verify')
    await t.tick()
    expect(get(run).state).toBe('verified')
    expect(get(run).deployLinks?.[1]?.status).toBe('waiting')
  })

  it('verifies right after the merge when no app deploys the repo', async () => {
    const run = merged()
    const { rescan } = rescanFixing([1, 2])
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'verified', deployLinks: [] })
    expect(get(run).verification).toMatchObject({ after: 'merge', cleared: [1, 2] })
  })

  it('gives up after three days without a deploy and stays merged', async () => {
    app('app-1')
    const run = merged()
    const { tracker: t } = tracker()
    await t.tick()
    advance(3 * DAY + MINUTE)
    await t.tick()
    const row = get(run)
    expect(row.state).toBe('merged')
    expect(row.warnings).toMatchObject([{ code: 'deploy_not_seen', deploymentId: null }])
    expect(trackingPhase(row, clock)).toBeNull()
    expect(t.status(row)).toBeNull()
  })

  it('warns when the watch paths skip the files the fix changed', async () => {
    const web = app('app-1', { watchPaths: ['apps/web/**'] })
    app('app-2', { watchPaths: ['package.json', 'pnpm-lock.yaml'] })
    const run = merged()
    const { tracker: t } = tracker()
    await t.tick()
    advance(2 * MINUTE)
    await t.tick()
    const warnings = get(run).warnings
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ code: 'watch_paths_skip', deploymentId: web.id })
    expect(warnings[0]?.message).toContain('may not happen automatically')
  })

  it('records a Coolify error on the app and keeps waiting', async () => {
    const broken = app('app-1')
    repos.sources.update(coolifyId, { enabled: false })
    const run = merged()
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).deployLinks?.[0]).toMatchObject({
      deploymentId: broken.id,
      status: 'waiting',
      error: 'The source "edge" is switched off.',
    })
  })
})

describe('verification', () => {
  it('ends not cleared with the findings still open and the new ones', async () => {
    const run = merged()
    const extra = repos.advisories.upsert({
      advisoryKey: 'GHSA-tern-0001',
      ecosystem: 'npm',
      packageName: 'tern-cli',
      severity: 'moderate',
    })
    const fresh = repos.findings.observe(
      { kind: 'advisory', advisoryId: extra.id, repoId: harbor.id, reportedBy: ['osv'] },
      T0,
    ).finding
    const { rescan } = rescanFixing([1], [fresh.id])
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    const row = get(run)
    expect(row).toMatchObject({ state: 'not_cleared', stateReason: '1 findings still open' })
    expect(row.verification).toMatchObject({
      targeted: [1, 2],
      cleared: [1],
      stillOpen: [2],
      new: [fresh.id],
    })
  })

  it('verifies an empty diff run with the rescan', async () => {
    const { run } = repos.fixRuns.create(
      {
        repoId: harbor.id,
        plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
        runner: 'github_actions',
        kind: 'fix',
        correlationId: 'corr-2',
        checksMode: 'full',
      },
      T0,
    )
    repos.fixRuns.applyEvent(run.id, { type: 'dispatch_accepted', githubRunId: 9002 }, T0)
    repos.fixRuns.applyEvent(
      run.id,
      { type: 'run_completed', conclusion: 'success', nothingToDo: true },
      T0,
    )
    const { rescan } = rescanFixing([1, 2])
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'verified' })
    expect(get(run).verification).toMatchObject({ after: 'empty_diff', targeted: [1, 2] })
  })

  it('retries a failed rescan, then leaves it to the next full scan', async () => {
    const run = merged()
    let calls = 0
    const rescan: RepoRescanner = () => {
      calls += 1
      return Promise.resolve({ kind: 'failed', error: 'OSV did not answer' })
    }
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    expect(get(run).verification).toMatchObject({
      status: 'retrying',
      attempts: 1,
      lastError: 'OSV did not answer',
      nextAttemptAt: new Date(clock.getTime() + 5 * MINUTE).toISOString(),
    })
    advance(4 * MINUTE)
    await t.tick()
    expect(calls).toBe(1)
    for (const wait of [5, 10, 20, 40]) {
      advance(wait * MINUTE)
      await t.tick()
    }
    expect(calls).toBe(5)
    expect(get(run).state).toBe('merged')
    expect(get(run).verification).toMatchObject({ status: 'scheduled_scan', attempts: 5 })
    expect(trackingPhase(get(run), clock)).toBeNull()

    // A full scan that started after the merge and read the repo verifies the run.
    advance(MINUTE)
    repos.findings.changeState(1, { state: 'fixed', actor: 'system' }, clock)
    repos.findings.changeState(2, { state: 'fixed', actor: 'system' }, clock)
    repos.repos.markScanned(harbor.id, clock)
    const verified = t.scanFinished({
      scanRunId: 77,
      status: 'partial',
      startedAt: clock,
      finishedAt: clock,
      failedRepos: ['kestrel-co/other'],
      changes: [
        { findingId: 1, change: 'fixed' },
        { findingId: 2, change: 'fixed' },
      ],
    })
    expect(verified).toBe(1)
    expect(get(run)).toMatchObject({ state: 'verified' })
    expect(get(run).verification).toMatchObject({ scan: { kind: 'full', scanRunId: 77 } })
  })

  it('ignores full scans that failed on the repo, started too early or failed outright', () => {
    const run = merged()
    repos.fixRuns.saveVerify(run.id, { deployLinks: [] })
    const { tracker: t } = tracker()
    repos.repos.markScanned(harbor.id, clock)
    const base = { scanRunId: 5, finishedAt: clock, changes: [] }
    expect(
      t.scanFinished({
        ...base,
        status: 'partial',
        startedAt: clock,
        failedRepos: ['Kestrel-Co/Harbor'],
      }),
    ).toBe(0)
    expect(t.scanFinished({ ...base, status: 'failed', startedAt: clock, failedRepos: [] })).toBe(0)
    expect(
      t.scanFinished({
        ...base,
        status: 'succeeded',
        startedAt: new Date(T0.getTime() - MINUTE),
        failedRepos: [],
      }),
    ).toBe(0)
    expect(get(run).state).toBe('merged')
  })

  it('asks again shortly while a full scan is running', async () => {
    const run = merged()
    let busy = true
    const rescan: RepoRescanner = () =>
      Promise.resolve<RepoRescanOutcome>(
        busy ? { kind: 'busy' } : { kind: 'done', at: clock, changes: [] },
      )
    const { tracker: t } = tracker({ rescan })
    await t.tick()
    expect(get(run).verification).toMatchObject({ status: 'pending', attempts: 0 })
    expect(t.status(get(run))?.nextPollAt).toEqual(new Date(clock.getTime() + 2 * MINUTE))
    busy = false
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('not_cleared')
  })
})
