import {
  FIX_PLAN_VERSION,
  FIX_RESULT_SCHEMA,
  fixRunSchema,
  parseFixResult,
  type FixPlan,
} from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toFixRun } from '../api/serialize.js'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import { FIX_PLANS_KEPT_PER_REPO, type CreateFixRunInput, type Repositories } from './index.js'

// Every repo and URL here is fictional.

const T0 = new Date('2026-11-07T08:00:00.000Z')
const T1 = new Date('2026-11-07T08:05:00.000Z')
const T2 = new Date('2026-11-07T09:00:00.000Z')

let repos: Repositories
let handle: DatabaseHandle
let storefront: RepoRow
let ledger: RepoRow

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  storefront = repos.repos.upsert({
    owner: 'kestrel-co',
    name: 'storefront',
    defaultBranch: 'main',
  })
  ledger = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger', defaultBranch: 'main' })
})
afterEach(() => handle.close())

/** Saves an empty plan for the repo from a new scan run. */
function savePlan(repo: RepoRow, at = T0) {
  const scan = repos.scanRuns.start('manual', at)
  const tiers = {}
  const plan = {
    version: FIX_PLAN_VERSION,
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: `${repo.owner}/${repo.name}`,
      archived: false,
      alertsEnabled: true,
      lastScannedAt: null,
    },
    scanRunId: scan.id,
    createdAt: at.toISOString(),
    projects: [],
    steps: [],
    unfixed: [],
    summary: {
      findings: {
        total: 0,
        cleared: 0,
        clearedSafely: 0,
        unfixed: 0,
        clearedByTier: tiers,
        unfixedByTier: tiers,
      },
      steps: { safe: 0, risky: 0 },
      unfixed: 0,
    },
    previous: null,
  } as unknown as FixPlan
  return repos.fixPlans.save(plan, at)
}

let correlation = 0
function input(repo: RepoRow, fields: Partial<CreateFixRunInput> = {}): CreateFixRunInput {
  const plan = savePlan(repo)
  correlation += 1
  return {
    repoId: repo.id,
    plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
    runner: 'github_actions',
    kind: 'fix',
    correlationId: `corr-${correlation}`,
    checksMode: 'install',
    ...fields,
  }
}

describe('fix runs repository', () => {
  it('creates a pending run on the kind branch and reads it back', () => {
    const { run, superseded } = repos.fixRuns.create(input(storefront), T0)
    expect(superseded).toEqual([])
    expect(run).toMatchObject({
      repoId: storefront.id,
      runner: 'github_actions',
      kind: 'fix',
      branch: 'hinomi/fix-plan',
      checksMode: 'install',
      state: 'pending',
      prDraft: false,
      result: null,
      createdAt: T0,
      stateChangedAt: T0,
    })
    expect(repos.fixRuns.get(run.id)).toEqual(run)
    expect(repos.fixRuns.getByCorrelationId(run.correlationId)).toEqual(run)
    const majors = repos.fixRuns.create(input(storefront, { kind: 'majors' }), T0).run
    expect(majors.branch).toBe('hinomi/majors')
  })

  it('tells listeners about committed changes only, and survives a throwing one', () => {
    const seen: string[] = []
    const off = repos.fixRuns.onChanged((run) => seen.push(`${run.id}:${run.state}`))
    repos.fixRuns.onChanged(() => {
      throw new Error('listener failure')
    })
    const { run } = repos.fixRuns.create(input(storefront), T0)
    expect(seen).toEqual([])
    const accepted = { type: 'dispatch_accepted', githubRunId: 9001 } as const
    expect(repos.fixRuns.applyEvent(run.id, accepted, T1)).toMatchObject({ changed: true })
    expect(repos.fixRuns.applyEvent(run.id, accepted, T1)).toMatchObject({ changed: false })
    expect(repos.fixRuns.applyEvent(run.id, { type: 'pr_closed' }, T1).ok).toBe(false)
    expect(repos.fixRuns.saveVerify(run.id, {}, null, T1)).toMatchObject({ changed: false })
    expect(repos.fixRuns.saveVerify(run.id, { warnings: [] }, null, T1)).toMatchObject({
      changed: true,
    })
    const next = repos.fixRuns.create(input(storefront), T2).run
    expect(seen).toEqual([`${run.id}:dispatched`, `${run.id}:dispatched`, `${run.id}:superseded`])
    expect(next.state).toBe('pending')
    off()
    repos.fixRuns.applyEvent(next.id, { type: 'failed', reason: 'boom' }, T2)
    expect(seen).toHaveLength(3)
  })

  it('refuses a duplicate correlation id', () => {
    repos.fixRuns.create(input(storefront, { correlationId: 'same' }), T0)
    expect(() => repos.fixRuns.create(input(ledger, { correlationId: 'same' }), T0)).toThrow(
      /UNIQUE/,
    )
  })

  it('applies events in order and persists every field', () => {
    const { run } = repos.fixRuns.create(input(storefront), T0)
    const events = [
      { type: 'dispatch_accepted', githubRunId: 9001, githubRunAttempt: 1 },
      { type: 'run_started' },
      { type: 'run_completed', conclusion: 'success', headSha: 'c0ffee1' },
      {
        type: 'pr_opened',
        number: 42,
        url: 'https://github.com/kestrel-co/storefront/pull/42',
        draft: true,
      },
      { type: 'checks_updated', status: 'failing' },
    ] as const
    for (const event of events) {
      expect(repos.fixRuns.applyEvent(run.id, event, T1)).toMatchObject({ ok: true, changed: true })
    }
    const stored = repos.fixRuns.get(run.id)
    expect(stored).toMatchObject({
      state: 'checks_failing',
      githubRunId: 9001,
      githubRunAttempt: 1,
      headSha: 'c0ffee1',
      prNumber: 42,
      prDraft: true,
      dispatchedAt: T1,
      checksUpdatedAt: T1,
    })
    expect(fixRunSchema.parse(toFixRun(stored!))).toMatchObject({
      state: 'checks_failing',
      terminal: false,
      github: { runId: 9001, runAttempt: 1 },
      pr: { number: 42, draft: true, mergeSha: null },
      at: { created: T0.toISOString(), merged: null },
    })
  })

  it('returns rejections without writing, and repeats without a write', () => {
    const { run } = repos.fixRuns.create(input(storefront), T0)
    const rejected = repos.fixRuns.applyEvent(
      run.id,
      { type: 'pr_merged', mergeSha: 'feed123' },
      T1,
    )
    expect(rejected).toMatchObject({ ok: false, rejection: { code: 'not_allowed' } })
    expect(repos.fixRuns.get(run.id)).toEqual(run)

    const accepted = { type: 'dispatch_accepted', githubRunId: null } as const
    expect(repos.fixRuns.applyEvent(run.id, accepted, T1)).toMatchObject({ changed: true })
    const after = repos.fixRuns.get(run.id)
    expect(repos.fixRuns.applyEvent(run.id, accepted, T2)).toEqual({
      ok: true,
      run: after,
      changed: false,
    })
    expect(repos.fixRuns.get(run.id)).toEqual(after)

    expect(repos.fixRuns.applyEvent(9999, accepted, T1)).toMatchObject({
      ok: false,
      rejection: { code: 'not_found' },
    })
  })

  it('refuses to link a workflow run another fix run of the repo already has', () => {
    const first = repos.fixRuns.create(input(storefront, { kind: 'majors' }), T0).run
    repos.fixRuns.applyEvent(first.id, { type: 'dispatch_accepted', githubRunId: 9001 }, T0)
    const second = repos.fixRuns.create(input(storefront), T0).run
    const linked = repos.fixRuns.applyEvent(
      second.id,
      { type: 'run_linked', githubRunId: 9001 },
      T1,
    )
    expect(linked).toMatchObject({ ok: false, rejection: { code: 'conflict' } })
    expect(repos.fixRuns.get(second.id)?.githubRunId).toBeNull()

    const other = repos.fixRuns.create(input(ledger), T0).run
    const elsewhere = repos.fixRuns.applyEvent(
      other.id,
      { type: 'run_linked', githubRunId: 9001 },
      T1,
    )
    expect(elsewhere).toMatchObject({ ok: true, run: { githubRunId: 9001 } })
  })

  it('supersedes open runs of the same repo and kind, but not merged runs or other kinds', () => {
    const merged = repos.fixRuns.create(input(storefront), T0).run
    for (const event of [
      {
        type: 'pr_opened',
        number: 41,
        url: 'https://github.com/kestrel-co/storefront/pull/41',
        draft: false,
      },
      { type: 'pr_merged', mergeSha: 'feed123' },
    ] as const) {
      repos.fixRuns.applyEvent(merged.id, event, T0)
    }
    const old = repos.fixRuns.create(input(storefront), T0).run
    repos.fixRuns.applyEvent(old.id, { type: 'dispatch_accepted', githubRunId: 9001 }, T0)
    const majors = repos.fixRuns.create(input(storefront, { kind: 'majors' }), T0).run
    const other = repos.fixRuns.create(input(ledger), T0).run

    const { run, superseded } = repos.fixRuns.create(input(storefront), T1)
    expect(superseded.map((r) => r.id)).toEqual([old.id])
    expect(repos.fixRuns.get(old.id)).toMatchObject({
      state: 'superseded',
      stateReason: `superseded by run ${run.id}`,
      endedAt: T1,
    })
    expect(repos.fixRuns.get(merged.id)?.state).toBe('merged')
    expect(repos.fixRuns.get(majors.id)?.state).toBe('pending')
    expect(repos.fixRuns.get(other.id)?.state).toBe('pending')
  })

  it('lists the runs that ended since a time in the given states', () => {
    const failed = repos.fixRuns.create(input(storefront), T0).run
    repos.fixRuns.applyEvent(failed.id, { type: 'failed', reason: 'dispatch refused' }, T0)
    const lost = repos.fixRuns.create(input(ledger), T1).run
    repos.fixRuns.applyEvent(lost.id, { type: 'lost', reason: 'gave up' }, T1)
    const late = repos.fixRuns.create(input(storefront, { kind: 'majors' }), T1).run
    repos.fixRuns.applyEvent(late.id, { type: 'failed', reason: 'refused' }, T2)
    repos.fixRuns.create(input(ledger, { kind: 'majors' }), T2)

    expect(repos.fixRuns.listEndedSince(T0, ['failed']).map((r) => r.id)).toEqual([
      failed.id,
      late.id,
    ])
    expect(repos.fixRuns.listEndedSince(T1, ['failed', 'lost']).map((r) => r.id)).toEqual([
      lost.id,
      late.id,
    ])
    expect(repos.fixRuns.listEndedSince(T0, [])).toEqual([])
  })

  it('lists runs by repo, the active ones, and the latest per repo and kind', () => {
    const a = repos.fixRuns.create(input(storefront), T0).run
    repos.fixRuns.applyEvent(a.id, { type: 'failed', reason: 'dispatch refused' }, T0)
    const b = repos.fixRuns.create(input(storefront), T1).run
    const c = repos.fixRuns.create(input(storefront, { kind: 'majors' }), T1).run
    const d = repos.fixRuns.create(input(ledger), T1).run

    expect(repos.fixRuns.listByRepo(storefront.id).map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect(
      repos.fixRuns.listByRepo(storefront.id, { kind: 'fix', limit: 1 }).map((r) => r.id),
    ).toEqual([b.id])
    expect(repos.fixRuns.listActive().map((r) => r.id)).toEqual([b.id, c.id, d.id])
    expect(repos.fixRuns.latest(storefront.id, 'fix')?.id).toBe(b.id)
    expect(repos.fixRuns.latest(storefront.id, 'majors')?.id).toBe(c.id)
    expect(repos.fixRuns.latest(ledger.id, 'majors')).toBeUndefined()
    expect(
      repos.fixRuns
        .latestPerRepo('fix')
        .map((r) => r.id)
        .sort(),
    ).toEqual([b.id, d.id].sort())
    expect(repos.fixRuns.latestPerRepo('majors').map((r) => r.id)).toEqual([c.id])
  })

  it('finds the last PR of a repo when it was closed without merging', () => {
    const pr = (n: number) =>
      ({
        type: 'pr_opened',
        number: n,
        url: `https://github.com/kestrel-co/storefront/pull/${n}`,
        draft: false,
      }) as const
    expect(repos.fixRuns.closedUnmergedPrevious(storefront.id, 'fix')).toBeUndefined()

    const first = repos.fixRuns.create(input(storefront), T0).run
    repos.fixRuns.applyEvent(first.id, pr(40), T0)
    repos.fixRuns.applyEvent(first.id, { type: 'pr_closed' }, T1)
    expect(repos.fixRuns.closedUnmergedPrevious(storefront.id, 'fix')?.id).toBe(first.id)
    expect(repos.fixRuns.closedUnmergedPrevious(storefront.id, 'majors')).toBeUndefined()

    // A newer run that has not opened a PR yet does not hide the closed one.
    const second = repos.fixRuns.create(input(storefront), T1).run
    expect(repos.fixRuns.closedUnmergedPrevious(storefront.id, 'fix')?.id).toBe(first.id)

    repos.fixRuns.applyEvent(second.id, pr(41), T2)
    expect(repos.fixRuns.closedUnmergedPrevious(storefront.id, 'fix')).toBeUndefined()
  })

  it('stores the runner result without touching the state', () => {
    const { run } = repos.fixRuns.create(input(storefront), T0)
    const result = parseFixResult({
      schema: FIX_RESULT_SCHEMA,
      runId: run.correlationId,
      planScanRunId: run.planScanRunId,
      repo: 'kestrel-co/storefront',
      baseSha: 'a'.repeat(40),
      packageManager: 'pnpm',
      packageManagerVersion: null,
      checksMode: 'install',
      steps: [],
      releaseAge: [],
      install: { status: 'ok', durationMs: 1000, output: null, truncated: false },
      checks: [],
      patch: null,
      finishedAt: T1.toISOString(),
    })
    expect(repos.fixRuns.setResult(run.id, result)).toMatchObject({ state: 'pending', result })
    expect(repos.fixRuns.get(run.id)?.result).toEqual(result)
  })

  it('stores and clears poll ETags', () => {
    const { run } = repos.fixRuns.create(input(storefront), T0)
    repos.fixRuns.setEtags(run.id, { run: 'W/"r1"', checks: 'W/"c1"' })
    expect(repos.fixRuns.get(run.id)).toMatchObject({
      runEtag: 'W/"r1"',
      prEtag: null,
      checksEtag: 'W/"c1"',
    })
    expect(repos.fixRuns.setEtags(run.id, { checks: null, pr: 'W/"p1"' })).toMatchObject({
      runEtag: 'W/"r1"',
      prEtag: 'W/"p1"',
      checksEtag: null,
    })
    expect(repos.fixRuns.setEtags(run.id, {})?.runEtag).toBe('W/"r1"')
  })

  it('keeps the plan of an unfinished run when plans are pruned, and outlives a pruned plan', () => {
    const ended = repos.fixRuns.create(input(storefront), T0).run
    repos.fixRuns.applyEvent(ended.id, { type: 'lost', reason: 'gave up' }, T0)
    const active = repos.fixRuns.create(input(storefront), T0).run
    for (let i = 0; i < FIX_PLANS_KEPT_PER_REPO + 2; i += 1) savePlan(storefront)

    expect(
      handle.sqlite
        .prepare('select count(*) from fix_plans where id = ?')
        .pluck()
        .get(active.fixPlanId),
    ).toBe(1)
    expect(repos.fixRuns.get(active.id)?.fixPlanId).toBe(active.fixPlanId)
    expect(repos.fixRuns.get(ended.id)).toMatchObject({
      fixPlanId: null,
      planScanRunId: ended.planScanRunId,
      planVersion: FIX_PLAN_VERSION,
    })
  })

  it('goes away with its repo', () => {
    const { run } = repos.fixRuns.create(input(ledger), T0)
    expect(repos.repos.remove(ledger.id)).toBe(true)
    expect(repos.fixRuns.get(run.id)).toBeUndefined()
  })
})

describe('deployment links and verification', () => {
  it('stores them with the event in one step, and nothing when the event is refused', () => {
    const { run } = repos.fixRuns.create(input(storefront), T0)
    for (const event of [
      { type: 'dispatch_accepted' as const, githubRunId: 41 },
      { type: 'pr_opened' as const, number: 3, url: 'https://github.com/x/y/pull/3', draft: false },
      { type: 'pr_merged' as const, mergeSha: 'e'.repeat(40) },
    ]) {
      repos.fixRuns.applyEvent(run.id, event, T0)
    }
    expect(repos.fixRuns.get(run.id)).toMatchObject({ deployLinks: null, warnings: [] })

    const seen = repos.fixRuns.saveVerify(
      run.id,
      { deployLinks: [] },
      { type: 'deployment_seen' },
      T1,
    )
    expect(seen).toMatchObject({
      ok: true,
      run: { state: 'deployed', deployLinks: [], deployedAt: T1 },
    })

    // `pr_closed` cannot move a deployed run; the links stay as they were.
    const refused = repos.fixRuns.saveVerify(
      run.id,
      { deployLinks: null },
      { type: 'pr_closed' },
      T2,
    )
    expect(refused.ok).toBe(false)
    expect(repos.fixRuns.get(run.id)?.deployLinks).toEqual([])

    const plain = repos.fixRuns.saveVerify(run.id, { warnings: [] })
    expect(plain).toMatchObject({ ok: true, changed: true })
    expect(repos.fixRuns.saveVerify(999, {})).toMatchObject({ ok: false })
  })
})
