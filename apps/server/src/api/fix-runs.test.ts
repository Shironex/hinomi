import {
  dispatchFixRunResponseSchema,
  fixRunReopenRequiredSchema,
  fixRunDetailSchema,
  fixRunsResponseSchema,
  renderCallerWorkflow,
  runnerStatusSchema,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { Repositories } from '../repository/index.js'
import {
  connectGithubToken,
  fakeGithub,
  fileReply,
  repoReply,
  saveRunnerPlan,
  type FakeRoute,
} from '../runner/testing.js'
import { createTestApi } from './testing.js'

// The runner settings and fix run routes, against a fake GitHub. Every name is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const PINNED = 'c'.repeat(40)
const CALLER = '/repos/kestrel-co/harbor/contents/.github/workflows/hinomi-fix.yml?ref=main'
const DISPATCHES = '/repos/kestrel-co/harbor/actions/workflows/hinomi-fix.yml/dispatches'

function github(extra: FakeRoute[] = []) {
  return fakeGithub([
    ...extra,
    { path: '/repos/kestrel-co/harbor', reply: repoReply('kestrel-co', 'harbor', 'public') },
    { path: '/user', reply: { body: { login: 'kestrel-bot' } } },
    { path: /\/actions\/workflows\/hinomi-fix\.yml$/, reply: { body: { id: 1 } } },
    { path: /\/pulls\?/, reply: { body: [] } },
    { path: /\/commits\?/, reply: { body: [] } },
    { path: CALLER, reply: fileReply(renderCallerWorkflow({ sha: PINNED })) },
    { method: 'POST', path: DISPATCHES, reply: { body: { workflow_run_id: 7001 } } },
  ])
}

function setup(extra: FakeRoute[] = [], options: Parameters<typeof createTestApi>[0] = {}) {
  const gh = github(extra)
  const api = createTestApi({ ...options, sourceFetch: gh.fetch })
  const harbor = api.repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  return { ...api, harbor, requests: gh.requests }
}

/** A finished run whose fix PR was closed without merging. */
function closedUnmergedRun(repos: Repositories, repoId: number) {
  const plan = saveRunnerPlan(repos, repos.repos.get(repoId)!, T0)
  const { run } = repos.fixRuns.create(
    {
      repoId,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: 1 },
      runner: 'github_actions',
      kind: 'fix',
      correlationId: 'run-closed-1',
      checksMode: 'full',
    },
    T0,
  )
  for (const event of [
    { type: 'dispatch_accepted', githubRunId: 6001 },
    {
      type: 'pr_opened',
      number: 14,
      url: 'https://github.com/kestrel-co/harbor/pull/14',
      draft: false,
    },
    { type: 'pr_closed' },
  ] as const) {
    expect(repos.fixRuns.applyEvent(run.id, event, T0).ok).toBe(true)
  }
  return run
}

describe('GET and PATCH /api/repos/:id/runner', () => {
  it('starts off with the default workflow and explains a missing GitHub source', async () => {
    const { call, harbor } = setup()
    const res = await call('GET', `/repos/${harbor.id}/runner`)
    expect(res.status).toBe(200)
    const status = runnerStatusSchema.parse(res.json)
    expect(status).toMatchObject({
      settings: { enabled: false, workflow: 'hinomi-fix.yml' },
      defaultWorkflow: 'hinomi-fix.yml',
      ready: false,
      github: null,
      permissions: { auth: null, ok: false },
      caller: { state: 'unknown', path: '.github/workflows/hinomi-fix.yml' },
      latestRun: null,
      closedUnmerged: null,
    })
    expect(status.message).toContain('Connect a GitHub source')
    expect(status.caller.template).toContain('workflow_dispatch')
    expect((await call('GET', '/repos/9999/runner')).status).toBe(404)
  })

  it('turns the runner on and reports permissions and the caller pin', async () => {
    const { call, harbor, repos, requests } = setup()
    connectGithubToken(repos)
    const res = await call('PATCH', `/repos/${harbor.id}/runner`, { enabled: true })
    expect(res.status).toBe(200)
    const status = runnerStatusSchema.parse(res.json)
    expect(status).toMatchObject({
      settings: { enabled: true, workflow: 'hinomi-fix.yml' },
      ready: true,
      github: {
        fullName: 'kestrel-co/harbor',
        defaultBranch: 'main',
        visibility: 'public',
        checksMode: 'full',
      },
      permissions: { auth: 'fine_grained_token', ok: true },
      caller: { state: 'pinned', ref: PINNED, missingInputs: [] },
      message: 'Ready to dispatch.',
    })
    // The status only reads.
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
    expect(repos.repos.get(harbor.id)?.runnerEnabled).toBe(true)
  })

  it('stores another workflow file, resets it with null, and refuses a path', async () => {
    const { call, harbor, repos } = setup()
    const custom = await call('PATCH', `/repos/${harbor.id}/runner`, { workflow: 'fix-deps.yaml' })
    expect(runnerStatusSchema.parse(custom.json).settings.workflow).toBe('fix-deps.yaml')
    expect(repos.repos.get(harbor.id)?.runnerWorkflow).toBe('fix-deps.yaml')

    const reset = await call('PATCH', `/repos/${harbor.id}/runner`, { workflow: null })
    expect(runnerStatusSchema.parse(reset.json).settings.workflow).toBe('hinomi-fix.yml')

    for (const workflow of ['../ci.yml', 'deploy.sh', '.github/workflows/x.yml']) {
      expect((await call('PATCH', `/repos/${harbor.id}/runner`, { workflow })).status).toBe(400)
    }
    expect((await call('PATCH', `/repos/${harbor.id}/runner`, { other: true })).status).toBe(400)
  })
})

describe('POST /api/repos/:id/fix-runs', () => {
  it('refuses while the runner is off or there is no plan', async () => {
    const { call, harbor, repos } = setup()
    connectGithubToken(repos)
    const off = await call('POST', `/repos/${harbor.id}/fix-runs`, {})
    expect(off.status).toBe(409)
    expect(off.text).toContain('off for this repo')

    repos.repos.setRunner(harbor.id, { enabled: true })
    const noPlan = await call('POST', `/repos/${harbor.id}/fix-runs`, {})
    expect(noPlan.status).toBe(404)
    expect((await call('POST', '/repos/9999/fix-runs', {})).status).toBe(404)
  })

  it('dispatches the latest plan and serves the run', async () => {
    const { call, harbor, repos, requests } = setup()
    connectGithubToken(repos)
    repos.repos.setRunner(harbor.id, { enabled: true })
    saveRunnerPlan(repos, harbor, T0)

    const res = await call('POST', `/repos/${harbor.id}/fix-runs`)
    expect(res.status).toBe(201)
    const body = dispatchFixRunResponseSchema.parse(res.json)
    expect(body).toMatchObject({
      encoding: 'json',
      omittedStepIds: [],
      run: { state: 'dispatched', checksMode: 'full', github: { runId: 7001, runAttempt: null } },
    })
    const post = requests.find((r) => r.method === 'POST')
    expect(post?.body).toMatchObject({
      ref: 'main',
      inputs: { run_id: body.run.correlationId, encoding: 'json' },
      return_run_details: true,
    })

    const list = fixRunsResponseSchema.parse(
      (await call('GET', `/repos/${harbor.id}/fix-runs?kind=fix&limit=5`)).json,
    )
    expect(list.items.map((r) => r.id)).toEqual([body.run.id])
    const one = fixRunDetailSchema.parse((await call('GET', `/fix-runs/${body.run.id}`)).json)
    expect(one).toMatchObject({
      correlationId: body.run.correlationId,
      tracking: null,
      deployments: [],
      warnings: [],
      verification: null,
    })
    expect((await call('GET', '/fix-runs/9999')).status).toBe(404)
    expect((await call('GET', `/repos/${harbor.id}/fix-runs?limit=0`)).status).toBe(400)

    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.latestRun?.id).toBe(body.run.id)
  })

  it('answers 201 with a failed run when GitHub refuses the dispatch', async () => {
    const { call, harbor, repos } = setup([
      {
        method: 'POST',
        path: DISPATCHES,
        reply: { status: 404, body: { message: 'Not Found' } },
      },
    ])
    connectGithubToken(repos)
    repos.repos.setRunner(harbor.id, { enabled: true })
    saveRunnerPlan(repos, harbor, T0)
    const res = await call('POST', `/repos/${harbor.id}/fix-runs`, {})
    expect(res.status).toBe(201)
    const { run } = dispatchFixRunResponseSchema.parse(res.json)
    expect(run).toMatchObject({ state: 'failed', terminal: true })
    expect(run.stateReason).toContain('Add the caller workflow')
  })

  it('asks before dispatching again after a closed unmerged PR', async () => {
    const { call, harbor, repos } = setup()
    connectGithubToken(repos)
    repos.repos.setRunner(harbor.id, { enabled: true })
    const closed = closedUnmergedRun(repos, harbor.id)

    const ask = await call('POST', `/repos/${harbor.id}/fix-runs`, {})
    expect(ask.status).toBe(409)
    const body = fixRunReopenRequiredSchema.parse(ask.json)
    expect(body).toMatchObject({
      error: { code: 'conflict' },
      previous: {
        runId: closed.id,
        pr: { number: 14, url: 'https://github.com/kestrel-co/harbor/pull/14' },
        closedAt: T0.toISOString(),
      },
    })
    expect(repos.fixRuns.listByRepo(harbor.id)).toHaveLength(1)

    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.closedUnmerged?.pr.number).toBe(14)

    const confirmed = await call('POST', `/repos/${harbor.id}/fix-runs`, { confirmReopen: true })
    expect(confirmed.status).toBe(201)
    expect(dispatchFixRunResponseSchema.parse(confirmed.json).run.state).toBe('dispatched')
  })
})

describe('fix run tracking state', () => {
  it('adds what the tracker knows to a run', async () => {
    const T1 = new Date('2026-11-07T10:00:20.000Z')
    const { repos, harbor, call } = setup([], {
      fixRunTracking: {
        status: (run) =>
          run.state === 'dispatched'
            ? {
                lastPolledAt: T0,
                nextPollAt: T1,
                lastError: 'GitHub answered 502',
                pausedUntil: null,
              }
            : null,
      },
    })
    connectGithubToken(repos)
    saveRunnerPlan(repos, harbor, T0)
    await call('PATCH', `/repos/${harbor.id}/runner`, { enabled: true })
    const created = dispatchFixRunResponseSchema.parse(
      (await call('POST', `/repos/${harbor.id}/fix-runs`, {})).json,
    )
    const one = fixRunDetailSchema.parse((await call('GET', `/fix-runs/${created.run.id}`)).json)
    expect(one.tracking).toEqual({
      lastPolledAt: T0.toISOString(),
      nextPollAt: T1.toISOString(),
      lastError: 'GitHub answered 502',
      pausedUntil: null,
    })
  })
})

describe('fix run deployments and verification', () => {
  it('serves the linked deploys, warnings and the verification summary', async () => {
    const { repos, harbor, call } = setup()
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { run } = repos.fixRuns.create(
      {
        repoId: harbor.id,
        plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
        runner: 'github_actions',
        kind: 'fix',
        correlationId: 'corr-9',
        checksMode: 'full',
      },
      T0,
    )
    const deployments = [
      {
        deploymentId: 3,
        name: 'harbor-web',
        branch: 'main',
        status: 'deployed' as const,
        deploy: {
          id: 'dep-1',
          commit: 'f'.repeat(40),
          relation: 'ahead' as const,
          finishedAt: T0.toISOString(),
        },
        checkedAt: T0.toISOString(),
        error: null,
      },
    ]
    const warnings = [
      {
        code: 'watch_paths_skip' as const,
        deploymentId: 3,
        message: 'The watch paths of harbor-web match none of the files the fix changed.',
        at: T0.toISOString(),
      },
    ]
    const verification = {
      after: 'deploy' as const,
      status: 'done' as const,
      scan: { kind: 'repo' as const, scanRunId: null, at: T0.toISOString() },
      targeted: [1, 2],
      cleared: [1],
      stillOpen: [2],
      new: [],
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    }
    repos.fixRuns.saveVerify(run.id, { deployLinks: deployments, warnings, verification })
    const one = fixRunDetailSchema.parse((await call('GET', `/fix-runs/${run.id}`)).json)
    expect(one).toMatchObject({ deployments, warnings, verification })
  })
})
