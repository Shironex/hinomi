import { RUNNER_CALLBACK_SCHEMA, type FixRunKind, type FixRunnerKind } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixPlanRow, FixRunRow, RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { openRunnerGithub } from './github.js'
import {
  connectGithubToken,
  fakeGithub,
  runnerResult,
  saveRunnerPlan,
  type FakeReply,
} from './testing.js'
import { FIX_RUN_TRACKING, lostReason, trackingPhase } from './tracking.js'
import { handleRunnerCallback, type RunnerCallbackContext } from './webhook-callback.js'

// The webhook runner's callbacks mapped onto the fix run state machine, with a fake GitHub for
// the branch check. Every repo here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const HEAD = 'c'.repeat(40)
const BRANCH = '/repos/kestrel-co/harbor/branches/hinomi%2Ffix-plan'

let repos: Repositories
let handle: DatabaseHandle
let harbor: RepoRow
let plan: FixPlanRow

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  connectGithubToken(repos)
  plan = saveRunnerPlan(repos, harbor, T0)
})
afterEach(() => handle.close())

function webhookRun(
  correlationId = 'corr-webhook-1',
  kind: FixRunKind = 'fix',
  runner: FixRunnerKind = 'webhook',
): FixRunRow {
  const { run } = repos.fixRuns.create(
    {
      repoId: harbor.id,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
      runner,
      kind,
      correlationId,
      checksMode: 'install',
    },
    T0,
  )
  const accepted = repos.fixRuns.applyEvent(
    run.id,
    { type: 'dispatch_accepted', githubRunId: null },
    T0,
  )
  return accepted.ok ? accepted.run : run
}

function context(
  branchReply: FakeReply = { body: { name: 'hinomi/fix-plan', commit: { sha: HEAD } } },
) {
  const github = fakeGithub([{ path: BRANCH, reply: branchReply }])
  const polled: number[] = []
  const ctx: RunnerCallbackContext = {
    repositories: repos,
    github: (repoId) => openRunnerGithub(repos, repoId, { fetch: github.fetch }),
    now: () => T0,
    pollNow: (id) => polled.push(id),
  }
  return { ctx, polled, requests: github.requests }
}

function callback(runId: string, fields: Record<string, unknown>) {
  return { schema: RUNNER_CALLBACK_SCHEMA, runId, ...fields } as Parameters<
    typeof handleRunnerCallback
  >[1]
}

describe('handleRunnerCallback', () => {
  it('moves the run through queued and running', async () => {
    const run = webhookRun()
    const { ctx } = context()
    const queued = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'queued' }),
    )
    expect(queued.kind).toBe('applied')
    const running = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'running' }),
    )
    expect('run' in running && running.run.state).toBe('running')
    const again = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'running' }),
    )
    expect(again.kind).toBe('unchanged')
  })

  it('records a pushed branch after checking its head on GitHub, then asks for a poll', async () => {
    const run = webhookRun()
    const { ctx, polled, requests } = context()
    const result = runnerResult(plan.plan, run.correlationId, { repo: 'Kestrel-Co/Harbor' })
    const outcome = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result, headSha: HEAD }),
    )
    expect(outcome.kind).toBe('applied')
    expect(requests.map((r) => r.path)).toEqual([BRANCH])
    const stored = repos.fixRuns.get(run.id)
    expect(stored).toMatchObject({ state: 'branch_pushed', headSha: HEAD })
    expect(stored?.result?.runId).toBe(run.correlationId)
    expect(polled).toEqual([run.id])
    // The tracker takes over from here: the publish phase opens the PR.
    expect(stored && trackingPhase(stored, T0)).toBe('publish')
  })

  it('refuses a head that differs from the branch on GitHub and leaves the run as it was', async () => {
    const run = webhookRun()
    const { ctx, polled } = context({
      body: { name: 'hinomi/fix-plan', commit: { sha: 'd'.repeat(40) } },
    })
    const result = runnerResult(plan.plan, run.correlationId)
    const outcome = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result, headSha: HEAD }),
    )
    expect(outcome.kind).toBe('conflict')
    expect(repos.fixRuns.get(run.id)).toMatchObject({ state: 'dispatched', result: null })
    expect(polled).toEqual([])
  })

  it('answers unavailable when GitHub cannot be asked, so the runner can send it again', async () => {
    const run = webhookRun()
    const { ctx } = context({ status: 401, body: { message: 'Bad credentials' } })
    const result = runnerResult(plan.plan, run.correlationId)
    const outcome = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result, headSha: HEAD }),
    )
    expect(outcome.kind).toBe('unavailable')
    expect(repos.fixRuns.get(run.id)?.state).toBe('dispatched')
  })

  it('ends a run without a patch as nothing to do, and a majors run without one as failed', async () => {
    const run = webhookRun()
    const { ctx } = context()
    const empty = { ...runnerResult(plan.plan, run.correlationId), patch: null }
    await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result: empty }),
    )
    expect(repos.fixRuns.get(run.id)?.state).toBe('nothing_to_do')

    const majors = webhookRun('corr-majors-1', 'majors')
    const agentResult = {
      ...runnerResult(plan.plan, majors.correlationId),
      patch: null,
      agent: {
        preset: 'claude-code',
        outcome: 'no_changes',
        detail: null,
        summary: null,
        durationMs: 1000,
        turns: null,
        costUsd: null,
        refusedPaths: [],
      },
    }
    const outcome = await handleRunnerCallback(
      ctx,
      callback(majors.correlationId, { status: 'completed', result: agentResult }),
    )
    expect('run' in outcome && outcome.run.state).toBe('failed')
    expect(repos.fixRuns.get(majors.id)?.stateReason).toContain('without changing any file')
  })

  it('maps failed and cancelled, with the reason cleaned and cut', async () => {
    const failed = webhookRun('corr-f')
    const { ctx } = context()
    const reason = `install\u0007 broke\n\n${'x'.repeat(900)}`
    await handleRunnerCallback(ctx, callback(failed.correlationId, { status: 'failed', reason }))
    const stored = repos.fixRuns.get(failed.id)
    expect(stored?.state).toBe('failed')
    expect(stored?.stateReason?.startsWith('install broke x')).toBe(true)
    expect(stored?.stateReason?.length).toBe(500)

    const silent = webhookRun('corr-s')
    await handleRunnerCallback(ctx, callback(silent.correlationId, { status: 'failed' }))
    expect(repos.fixRuns.get(silent.id)?.stateReason).toBe(
      'The webhook runner reported a failure without a reason.',
    )

    const cancelled = webhookRun('corr-c')
    await handleRunnerCallback(ctx, callback(cancelled.correlationId, { status: 'cancelled' }))
    expect(repos.fixRuns.get(cancelled.id)?.state).toBe('cancelled')
  })

  it('refuses results that do not belong to the run, or lack what they need', async () => {
    const run = webhookRun()
    const { ctx } = context()
    const other = runnerResult(plan.plan, 'corr-someone-else')
    const wrongRun = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result: other, headSha: HEAD }),
    )
    expect(wrongRun).toMatchObject({ kind: 'invalid' })

    const wrongRepo = runnerResult(plan.plan, run.correlationId, { repo: 'kestrel-co/lighthouse' })
    expect(
      await handleRunnerCallback(
        ctx,
        callback(run.correlationId, { status: 'completed', result: wrongRepo, headSha: HEAD }),
      ),
    ).toMatchObject({ kind: 'invalid' })

    const noHead = runnerResult(plan.plan, run.correlationId)
    expect(
      await handleRunnerCallback(
        ctx,
        callback(run.correlationId, { status: 'completed', result: noHead }),
      ),
    ).toEqual({
      kind: 'invalid',
      message: 'A result with a patch needs the headSha of the pushed branch.',
    })

    expect(
      await handleRunnerCallback(ctx, callback(run.correlationId, { status: 'completed' })),
    ).toMatchObject({ kind: 'invalid' })

    expect(
      await handleRunnerCallback(
        ctx,
        callback(run.correlationId, { status: 'completed', result: { schema: 'nope' } }),
      ),
    ).toMatchObject({ kind: 'invalid' })
    expect(repos.fixRuns.get(run.id)?.state).toBe('dispatched')
  })

  it('finds only webhook runs by their correlation id', async () => {
    const actions = webhookRun('corr-actions', 'fix', 'github_actions')
    const { ctx } = context()
    expect(
      await handleRunnerCallback(ctx, callback(actions.correlationId, { status: 'running' })),
    ).toMatchObject({ kind: 'not_found' })
    expect(
      await handleRunnerCallback(ctx, callback('corr-unknown', { status: 'running' })),
    ).toMatchObject({
      kind: 'not_found',
    })
  })

  it('never replaces the result of an ended run', async () => {
    const run = webhookRun()
    const { ctx } = context()
    await handleRunnerCallback(ctx, callback(run.correlationId, { status: 'cancelled' }))
    const result = runnerResult(plan.plan, run.correlationId)
    const late = await handleRunnerCallback(
      ctx,
      callback(run.correlationId, { status: 'completed', result, headSha: HEAD }),
    )
    expect(late.kind).toBe('conflict')
    expect(repos.fixRuns.get(run.id)).toMatchObject({ state: 'cancelled', result: null })
  })
})

describe('tracking runs that report back', () => {
  it('waits without asking GitHub, and gives up after the external timeout', () => {
    const run = webhookRun()
    expect(trackingPhase(run, T0)).toBe('wait')
    expect(lostReason(run, new Date(T0.getTime() + FIX_RUN_TRACKING.externalLostAfterMs))).toBe(
      null,
    )
    const late = new Date(T0.getTime() + FIX_RUN_TRACKING.externalLostAfterMs + 1)
    expect(lostReason(run, late)).toBe(
      'The webhook runner sent no result within 120 minutes of the dispatch, so Hinomi stopped waiting for it.',
    )
  })

  it('keeps polling GitHub Actions runs on GitHub', () => {
    const run = webhookRun('corr-gha', 'fix', 'github_actions')
    expect(trackingPhase(run, T0)).toBe('link')
  })
})
