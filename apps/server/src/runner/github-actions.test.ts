import { decodeFixDispatch, encodeFixDispatch, type FixDispatchV1 } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixRunState } from '@hinomi/shared'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { MAX_DECOMPRESSED_PLAN_BYTES, zlibCompressor } from './compressor.js'
import { GithubActionsRunner } from './github-actions.js'
import { openRunnerGithub } from './github.js'
import {
  connectGithubToken,
  fakeGithub,
  repoReply,
  saveRunnerPlan,
  type FakeRequest,
  type FakeReply,
} from './testing.js'

// The GitHub Actions runner against a fake GitHub. Every repo here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const RUN_ID = 'run-4f2a9c'
const DISPATCHES = '/repos/Kestrel-Co/Harbor/actions/workflows/hinomi-fix.yml/dispatches'

let repos: Repositories
let handle: DatabaseHandle
let harbor: RepoRow

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  connectGithubToken(repos)
})
afterEach(() => handle.close())

function setup(
  visibility: 'public' | 'private',
  dispatchReply: FakeReply | ((request: FakeRequest) => FakeReply),
) {
  const github = fakeGithub([
    // GitHub spells the repo with capitals; the dispatch must use its spelling.
    { path: '/repos/kestrel-co/harbor', reply: repoReply('Kestrel-Co', 'Harbor', visibility) },
    { method: 'POST', path: DISPATCHES, reply: dispatchReply },
  ])
  const runner = new GithubActionsRunner({
    repositories: repos,
    github: (repoId) => openRunnerGithub(repos, repoId, { fetch: github.fetch }),
    now: () => T0,
    correlationId: () => RUN_ID,
  })
  return { runner, requests: github.requests }
}

const accepted: FakeReply = {
  body: {
    workflow_run_id: 9001,
    run_url: 'https://api.github.com/repos/Kestrel-Co/Harbor/actions/runs/9001',
    html_url: 'https://github.com/Kestrel-Co/Harbor/actions/runs/9001',
  },
}

async function sentDispatch(requests: FakeRequest[]): Promise<FixDispatchV1> {
  const post = requests.find((r) => r.method === 'POST')
  const body = post?.body as { inputs: Record<string, string> }
  return decodeFixDispatch(body.inputs.plan ?? '', body.inputs.encoding ?? '', {
    compressor: zlibCompressor,
  })
}

describe('GithubActionsRunner.dispatch', () => {
  it('posts the dispatch with the default branch, the three inputs and return_run_details', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, requests } = setup('private', accepted)
    const outcome = await runner.dispatch({ repo: harbor, plan })

    const post = requests.find((r) => r.method === 'POST')
    expect(post?.path).toBe(DISPATCHES)
    expect(post?.body).toEqual({
      ref: 'main',
      inputs: { run_id: RUN_ID, plan: expect.any(String) as string, encoding: 'json' },
      return_run_details: true,
    })
    const dispatch = await sentDispatch(requests)
    expect(dispatch).toMatchObject({
      runId: RUN_ID,
      dispatchedAt: T0.toISOString(),
      repo: { id: harbor.id, fullName: 'Kestrel-Co/Harbor', baseBranch: 'main' },
      plan: { version: 1, scanRunId: plan.scanRunId },
    })
    expect(dispatch.steps.map((s) => s.packageName)).toEqual(['plover-parse', 'heron-ui'])
    expect(dispatch.risky).toEqual([])

    expect(outcome).toMatchObject({ created: true, encoding: 'json', omittedStepIds: [] })
    if (!outcome.created) throw new Error('expected a run')
    expect(outcome.run).toMatchObject({
      state: 'dispatched',
      githubRunId: 9001,
      correlationId: RUN_ID,
      runner: 'github_actions',
      kind: 'fix',
      branch: 'hinomi/fix-plan',
      fixPlanId: plan.id,
      planScanRunId: plan.scanRunId,
      dispatchedAt: T0,
    })
  })

  it('runs full checks with no links on a public repo and install only with links on a private one', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const pub = setup('public', accepted)
    const publicOutcome = await pub.runner.dispatch({ repo: harbor, plan })
    expect((await sentDispatch(pub.requests)).options).toMatchObject({
      checks: 'full',
      linksAllowed: false,
      agent: false,
      releaseAgeDays: 7,
    })
    expect(publicOutcome.created && publicOutcome.run.checksMode).toBe('full')

    let n = 0
    const priv = new GithubActionsRunner({
      repositories: repos,
      github: (repoId) => openRunnerGithub(repos, repoId, { fetch: privateGithub.fetch }),
      now: () => T0,
      correlationId: () => `run-private-${++n}`,
    })
    const privateGithub = fakeGithub([
      { path: '/repos/kestrel-co/harbor', reply: repoReply('Kestrel-Co', 'Harbor', 'private') },
      { method: 'POST', path: DISPATCHES, reply: { ...accepted, body: { workflow_run_id: 9002 } } },
    ])
    const privateOutcome = await priv.dispatch({ repo: harbor, plan })
    expect((await sentDispatch(privateGithub.requests)).options).toMatchObject({
      checks: 'install',
      linksAllowed: true,
    })
    expect(privateOutcome.created && privateOutcome.run.checksMode).toBe('install')
  })

  it('records the run as pending before the dispatch goes out', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const seen: { state: FixRunState; correlationId: string }[] = []
    const { runner } = setup('private', () => {
      seen.push(...repos.fixRuns.listByRepo(harbor.id))
      return accepted
    })
    await runner.dispatch({ repo: harbor, plan })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ state: 'pending', correlationId: RUN_ID })
  })

  it('stores a run without a run id when GitHub answers 204 without details', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner } = setup('private', { status: 204 })
    const outcome = await runner.dispatch({ repo: harbor, plan })
    expect(outcome.created && outcome.run).toMatchObject({ state: 'dispatched', githubRunId: null })
  })

  it.each([
    [404, 'no workflow hinomi-fix.yml on main of Kestrel-Co/Harbor'],
    [403, 'needs Actions: write'],
    [422, 'the inputs run_id, plan and encoding'],
    [500, 'The dispatch failed'],
  ])('fails the run with a clear reason when GitHub answers %i', async (status, reason) => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, requests } = setup('private', {
      status,
      body: { message: 'refused by the fake' },
    })
    const outcome = await runner.dispatch({ repo: harbor, plan })
    if (!outcome.created) throw new Error('expected a run')
    expect(outcome.run.state).toBe('failed')
    expect(outcome.run.stateReason).toContain(reason)
    expect(outcome.run.endedAt).toEqual(T0)
    // A write is never repeated, even after a 5xx.
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('refuses without a run when there is no GitHub source or the repo cannot be read', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const none = new GithubActionsRunner({
      repositories: repos,
      github: () => ({ ok: false, message: 'Connect a GitHub source first.' }),
    })
    expect(await none.dispatch({ repo: harbor, plan })).toMatchObject({
      created: false,
      code: 'no_source',
    })

    const gone = fakeGithub([])
    const unreadable = new GithubActionsRunner({
      repositories: repos,
      github: (repoId) => openRunnerGithub(repos, repoId, { fetch: gone.fetch }),
    })
    expect(await unreadable.dispatch({ repo: harbor, plan })).toMatchObject({
      created: false,
      code: 'unavailable',
    })
    expect(repos.fixRuns.listByRepo(harbor.id)).toEqual([])
  })

  it('refuses a plan without a safe step', async () => {
    const scan = repos.scanRuns.start('manual', T0)
    const saved = saveRunnerPlan(repos, harbor, T0)
    const risky = repos.fixPlans.save(
      {
        ...saved.plan,
        scanRunId: scan.id,
        steps: saved.plan.steps.filter((s) => s.risk === 'risky'),
      },
      T0,
    )
    const { runner } = setup('private', accepted)
    expect(await runner.dispatch({ repo: harbor, plan: risky })).toMatchObject({
      created: false,
      code: 'nothing_to_send',
    })
  })
})

describe('GithubActionsRunner.dispatch of a majors run', () => {
  it('sends only the major upgrades with the agent on, as a majors run on hinomi/majors', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, requests } = setup('public', accepted)
    const outcome = await runner.dispatch({ repo: harbor, plan, kind: 'majors' })
    expect(outcome).toMatchObject({ created: true })
    if (!outcome.created) return
    expect(outcome.run).toMatchObject({ kind: 'majors', branch: 'hinomi/majors' })
    const dispatch = await sentDispatch(requests)
    expect(dispatch.steps).toEqual([])
    expect(dispatch.risky.map((r) => r.id)).toEqual(['s3'])
    expect(dispatch.options).toMatchObject({ agent: true, agentPreset: 'claude-code' })
  })

  it('refuses a plan without a major upgrade', async () => {
    const scan = repos.scanRuns.start('manual', T0)
    const saved = saveRunnerPlan(repos, harbor, T0)
    const safeOnly = repos.fixPlans.save(
      {
        ...saved.plan,
        scanRunId: scan.id,
        steps: saved.plan.steps.filter((s) => s.risk === 'safe'),
      },
      T0,
    )
    const { runner } = setup('private', accepted)
    expect(await runner.dispatch({ repo: harbor, plan: safeOnly, kind: 'majors' })).toMatchObject({
      created: false,
      code: 'nothing_to_send',
      message: 'The plan has no major upgrade the agent can take.',
    })
  })

  it('keeps the agent off in a fix dispatch', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, requests } = setup('public', accepted)
    await runner.dispatch({ repo: harbor, plan })
    const dispatch = await sentDispatch(requests)
    expect(dispatch.options.agent).toBe(false)
    expect(dispatch.options.agentPreset).toBeUndefined()
    expect(dispatch.risky).toEqual([])
  })
})

describe('zlibCompressor', () => {
  it('round trips a gzip plus base64 plan within a small budget', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, requests } = setup('private', accepted)
    await runner.dispatch({ repo: harbor, plan })
    const dispatch = await sentDispatch(requests)
    const encoded = await encodeFixDispatch(dispatch, { compressor: zlibCompressor, budget: 1200 })
    expect(encoded.encoding).toBe('gzip-base64')
    const back = await decodeFixDispatch(encoded.payload, encoded.encoding, {
      compressor: zlibCompressor,
    })
    expect(back.steps.map((s) => s.id)).toEqual(encoded.dispatch.steps.map((s) => s.id))
  })

  it('caps what a payload may inflate to', async () => {
    const bomb = await zlibCompressor.compress('a'.repeat(MAX_DECOMPRESSED_PLAN_BYTES + 1))
    await expect(zlibCompressor.decompress(bomb)).rejects.toThrow()
  })
})
