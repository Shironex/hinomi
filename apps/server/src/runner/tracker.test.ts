import { createHash } from 'node:crypto'
import type { FixResultV1 } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixPlanRow, FixRunRow, RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { decodeChecksEtag } from './tracker-poll.js'
import { createFixRunTracker, type FixRunTrackerOptions } from './tracker.js'
import {
  connectGithubToken,
  fakeGithub,
  repoReply,
  runnerResult,
  saveRunnerPlan,
  zipOf,
  type FakeReply,
  type FakeRequest,
} from './testing.js'
import { FIX_RUN_TRACKING, pollIntervalMs, trackingPhase } from './tracking.js'

// The fix run tracker against a fake GitHub that keeps a workflow run, its artifact, the fix
// branch, the PR and its checks. Every org, repo and URL here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const API = '/repos/kestrel-co/harbor'
const RUN_ID = 9001
const HEAD = 'c'.repeat(40)
const MERGE = 'e'.repeat(40)

interface FakePull {
  number: number
  node_id: string
  html_url: string
  state: 'open' | 'closed'
  draft: boolean
  title: string
  body: string
  merged_at: string | null
  merge_commit_sha: string | null
  closed_at: string | null
  labels: { name: string }[]
  head: { ref: string; sha: string }
  base: { ref: string }
}

interface World {
  run: {
    id: number
    run_attempt: number
    display_title: string
    status: string
    conclusion: string | null
    created_at: string
    updated_at: string
  }
  /** Runs the workflow runs list answers with (run name linking). */
  listed: World['run'][]
  artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean }[]
  zip: Uint8Array
  branchHead: string | null
  pulls: FakePull[]
  createPull: FakeReply | null
  checkRuns: { status: string; conclusion: string | null }[]
  status: { state: string; total_count: number }
  /** Extra headers on every API answer (rate limit). */
  headers: Record<string, string>
  /** Replaces the workflow run answer (errors). */
  runReply: FakeReply | null
}

let repos: Repositories
let handle: DatabaseHandle
let harbor: RepoRow
let plan: FixPlanRow
let clock: Date
let world: World

function etagOf(value: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)}"`
}

/** A conditional answer: 304 when the client sent the current ETag. */
function conditional(request: FakeRequest, body: unknown): FakeReply {
  const etag = etagOf(body)
  const headers = { ...world.headers, etag }
  if (request.ifNoneMatch === etag) return { status: 304, headers }
  return { body, headers }
}

function pull(number: number, overrides: Partial<FakePull> = {}): FakePull {
  return {
    number,
    node_id: `PR_node${number}`,
    html_url: `https://github.com/kestrel-co/harbor/pull/${number}`,
    state: 'open',
    draft: false,
    title: 'fix(deps): older title',
    body: '',
    merged_at: null,
    merge_commit_sha: null,
    closed_at: null,
    labels: [],
    head: { ref: 'hinomi/fix-plan', sha: HEAD },
    base: { ref: 'main' },
    ...overrides,
  }
}

function resultZip(result: FixResultV1): Uint8Array {
  return zipOf([
    { name: 'fix.patch', data: 'diff --git a/package.json b/package.json\n' },
    { name: 'hinomi-result.json', data: JSON.stringify(result) },
  ])
}

function github() {
  const reply = (body: unknown): FakeReply => ({ body, headers: world.headers })
  return fakeGithub([
    { path: API, reply: () => repoReply('kestrel-co', 'harbor', 'public') },
    {
      path: `${API}/actions/runs/${RUN_ID}`,
      reply: (request) => world.runReply ?? conditional(request, world.run),
    },
    {
      path: /^\/repos\/kestrel-co\/harbor\/actions\/workflows\/hinomi-fix\.yml\/runs\?/,
      reply: () => reply({ total_count: world.listed.length, workflow_runs: world.listed }),
    },
    {
      path: `${API}/actions/runs/${RUN_ID}/artifacts?per_page=100`,
      reply: () => reply({ total_count: world.artifacts.length, artifacts: world.artifacts }),
    },
    {
      path: /^\/repos\/kestrel-co\/harbor\/actions\/artifacts\/\d+\/zip$/,
      reply: { status: 302, headers: { location: 'https://blob.example.dev/artifact.zip?sig=1' } },
    },
    { path: '/artifact.zip?sig=1', reply: () => ({ raw: world.zip }) },
    {
      path: `${API}/branches/hinomi%2Ffix-plan`,
      reply: () =>
        world.branchHead
          ? reply({ name: 'hinomi/fix-plan', commit: { sha: world.branchHead } })
          : { status: 404, body: { message: 'Branch not found' } },
    },
    {
      path: /^\/repos\/kestrel-co\/harbor\/pulls\?/,
      reply: (request) => {
        const q = new URL(`https://x${request.path}`).searchParams
        return reply(world.pulls.filter((p) => p.state === q.get('state')))
      },
    },
    {
      method: 'POST',
      path: `${API}/pulls`,
      reply: (request) => {
        if (world.createPull) return world.createPull
        const sent = request.body as { title: string; body: string; draft: boolean }
        const created = pull(40, { title: sent.title, body: sent.body, draft: sent.draft })
        world.pulls.push(created)
        return { status: 201, body: created }
      },
    },
    {
      path: /^\/repos\/kestrel-co\/harbor\/pulls\/\d+$/,
      reply: (request) => {
        const number = Number(request.path.split('/').pop())
        const found = world.pulls.find((p) => p.number === number)
        return found ? conditional(request, found) : { status: 404, body: { message: 'Not Found' } }
      },
    },
    {
      path: `${API}/commits/${HEAD}/check-runs?per_page=100`,
      reply: (request) =>
        conditional(request, { total_count: world.checkRuns.length, check_runs: world.checkRuns }),
    },
    {
      path: `${API}/commits/${HEAD}/status`,
      reply: (request) => conditional(request, world.status),
    },
  ])
}

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  connectGithubToken(repos)
  plan = saveRunnerPlan(repos, harbor, T0)
  clock = T0
  world = {
    run: {
      id: RUN_ID,
      run_attempt: 1,
      display_title: 'hinomi fix corr-1',
      status: 'queued',
      conclusion: null,
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    },
    listed: [],
    artifacts: [{ id: 5, name: 'hinomi-fix-corr-1', size_in_bytes: 900, expired: false }],
    zip: resultZip(runnerResult(plan.plan, 'corr-1', { repo: 'kestrel-co/harbor' })),
    branchHead: HEAD,
    pulls: [],
    createPull: null,
    checkRuns: [],
    status: { state: 'pending', total_count: 0 },
    headers: { 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '1794000000' },
    runReply: null,
  }
})
afterEach(() => handle.close())

/** A dispatched run, linked to the workflow run unless `linked` is false. */
function dispatched(options: { linked?: boolean; correlationId?: string } = {}): FixRunRow {
  const { run } = repos.fixRuns.create(
    {
      repoId: harbor.id,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
      runner: 'github_actions',
      kind: 'fix',
      correlationId: options.correlationId ?? 'corr-1',
      checksMode: 'full',
    },
    clock,
  )
  const accepted = repos.fixRuns.applyEvent(
    run.id,
    { type: 'dispatch_accepted', githubRunId: options.linked === false ? null : RUN_ID },
    clock,
  )
  if (!accepted.ok) throw new Error('dispatch not accepted')
  return accepted.run
}

function tracker(extra: Partial<FixRunTrackerOptions> = {}) {
  const fake = github()
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

function get(run: FixRunRow): FixRunRow {
  const row = repos.fixRuns.get(run.id)
  if (!row) throw new Error('run gone')
  return row
}

describe('cadence', () => {
  it('polls fast while the run is young, slower for PRs, slowly for ended runs', () => {
    const run = dispatched()
    expect(trackingPhase(run, T0)).toBe('run')
    expect(pollIntervalMs(run, 'run', T0)).toBe(20 * SECOND)
    expect(pollIntervalMs(run, 'run', new Date(T0.getTime() + 6 * MINUTE))).toBe(MINUTE)
    const pr = { ...run, state: 'checks_pending' as const, prNumber: 40 }
    expect(trackingPhase(pr, T0)).toBe('pr')
    expect(pollIntervalMs(pr, 'pr', T0)).toBe(2 * MINUTE)
    const done = { ...pr, state: 'checks_passing' as const, checksUpdatedAt: T0 }
    expect(pollIntervalMs(done, 'pr', T0)).toBe(10 * MINUTE)
    expect(pollIntervalMs(done, 'pr', new Date(T0.getTime() + 4 * 24 * 60 * MINUTE))).toBe(
      60 * MINUTE,
    )
    const ended = { ...run, state: 'cancelled' as const, endedAt: T0 }
    expect(trackingPhase(ended, T0)).toBe('ended_run')
    expect(pollIntervalMs(ended, 'ended_run', T0)).toBe(30 * MINUTE)
    expect(trackingPhase(ended, new Date(T0.getTime() + 8 * 24 * 60 * MINUTE))).toBeNull()
    expect(trackingPhase({ ...run, githubRunId: null }, T0)).toBe('link')
    expect(trackingPhase({ ...run, state: 'merged' as const }, T0)).toBeNull()
    expect(trackingPhase({ ...run, state: 'superseded' as const, endedAt: T0 }, T0)).toBeNull()
  })
})

describe('workflow runs', () => {
  it('follows a run from queued to the fix PR, then the checks and the merge', async () => {
    const run = dispatched()
    const { tracker: t, requests } = tracker()

    await t.tick()
    expect(get(run)).toMatchObject({ state: 'queued', githubRunAttempt: 1 })
    expect(get(run).runEtag).toBe(etagOf(world.run))

    world.run = { ...world.run, status: 'in_progress' }
    advance(20 * SECOND)
    await t.tick()
    expect(get(run).state).toBe('running')

    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    advance(20 * SECOND)
    const summary = await t.tick()
    const published = get(run)
    expect(published).toMatchObject({
      state: 'pr_open',
      headSha: HEAD,
      prNumber: 40,
      result: { runId: 'corr-1' },
    })
    expect(summary.polled).toBe(1)
    const zip = requests.find((r) => r.host === 'blob.example.dev')
    expect(zip?.authorization).toBeNull()

    world.checkRuns = [{ status: 'in_progress', conclusion: null }]
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('checks_pending')
    expect(decodeChecksEtag(get(run).checksEtag)).toMatchObject({
      sha: HEAD,
      runs: { status: 'pending' },
      statuses: { status: 'none' },
    })

    world.checkRuns = [{ status: 'completed', conclusion: 'success' }]
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('checks_passing')

    const open = world.pulls[0]
    if (!open) throw new Error('no PR')
    world.pulls[0] = {
      ...open,
      state: 'closed',
      merged_at: clock.toISOString(),
      merge_commit_sha: MERGE,
      closed_at: clock.toISOString(),
    }
    advance(10 * MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'merged', mergeSha: MERGE })
    // Merged runs wait for a deployment, which the tracker does not follow.
    expect(t.status(get(run))).toBeNull()
  })

  it('sends the ETag back and changes nothing on a 304', async () => {
    const run = dispatched()
    const { tracker: t, requests } = tracker()
    await t.tick()
    advance(20 * SECOND)
    await t.tick()
    const runReads = requests.filter((r) => r.path === `${API}/actions/runs/${RUN_ID}`)
    expect(runReads.map((r) => r.ifNoneMatch)).toEqual([null, etagOf(world.run)])
    expect(get(run).state).toBe('queued')
  })

  it('waits for a run that is not due yet', async () => {
    dispatched()
    const { tracker: t, requests } = tracker()
    await t.tick()
    advance(5 * SECOND)
    const summary = await t.tick()
    expect(summary.polled).toBe(0)
    expect(summary.nextDelayMs).toBe(15 * SECOND)
    expect(requests.filter((r) => r.path.includes('/actions/runs/')).length).toBe(1)
  })

  it('maps each conclusion and keeps the result of a failed run', async () => {
    for (const [conclusion, state] of [
      ['failure', 'failed'],
      ['cancelled', 'cancelled'],
      ['timed_out', 'failed'],
      ['startup_failure', 'failed'],
    ] as const) {
      const run = dispatched({ correlationId: 'corr-1' })
      world.run = { ...world.run, status: 'completed', conclusion }
      const { tracker: t } = tracker()
      await t.tick()
      expect(get(run)).toMatchObject({ state, result: { runId: 'corr-1' } })
      handle.sqlite.prepare('delete from fix_runs').run()
    }
  })

  it('ends a run with an empty diff as nothing to do', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    world.zip = resultZip({
      ...runnerResult(plan.plan, 'corr-1', { repo: 'kestrel-co/harbor' }),
      patch: null,
    })
    const { tracker: t, requests } = tracker()
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'nothing_to_do', result: { patch: null } })
    expect(requests.some((r) => r.path.includes('/branches/'))).toBe(false)
  })

  it('waits for a missing artifact, then fails the run', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    world.artifacts = []
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'dispatched', runEtag: null })
    advance(6 * MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({
      state: 'failed',
      stateReason: 'The workflow run finished without its result artifact hinomi-fix-corr-1.',
    })
  })

  it('fails the run on a malformed artifact or a result for another run', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    world.zip = zipOf([{ name: 'hinomi-result.json', data: '{"schema":"hinomi.fix-result/1"' }])
    await tracker().tracker.tick()
    expect(get(run).state).toBe('failed')
    expect(get(run).stateReason).toMatch(/^The result artifact cannot be used: .*not JSON/)

    handle.sqlite.prepare('delete from fix_runs').run()
    const other = dispatched()
    world.zip = resultZip(runnerResult(plan.plan, 'corr-9', { repo: 'kestrel-co/harbor' }))
    await tracker().tracker.tick()
    expect(get(other).stateReason).toBe('The result artifact is for run corr-9, not corr-1.')
  })

  it('fails a successful run whose branch is missing', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    world.branchHead = null
    await tracker().tracker.tick()
    expect(get(run)).toMatchObject({ state: 'failed' })
    expect(get(run).stateReason).toMatch(/hinomi\/fix-plan is not on kestrel-co\/harbor/)
  })

  it('gives up on a run that runs too long or is gone', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'in_progress' }
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('running')
    advance(41 * MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'lost' })
    expect(get(run).stateReason).toMatch(/did not finish within 40 minutes/)

    handle.sqlite.prepare('delete from fix_runs').run()
    const gone = dispatched()
    world.runReply = { status: 404, body: { message: 'Not Found' } }
    await t.tick()
    expect(get(gone).stateReason).toMatch(/Workflow run 9001 is gone/)
  })
})

describe('run name linking', () => {
  it('links a run dispatched without its id by its run name', async () => {
    const run = dispatched({ linked: false })
    world.listed = [
      { ...world.run, id: 8000, display_title: 'hinomi fix someone-else' },
      { ...world.run, status: 'in_progress' },
    ]
    const { tracker: t, requests } = tracker()
    await t.tick()
    expect(get(run)).toMatchObject({ githubRunId: RUN_ID, state: 'running' })
    const list = requests.find((r) => r.path.includes('/workflows/'))
    const query = new URL(`https://x${list?.path ?? ''}`).searchParams
    expect(query.get('created')).toBe('>=2026-11-07T09:59:00.000Z')
    expect(query.get('event')).toBe('workflow_dispatch')
  })

  it('marks the run lost when no run by that name shows up in the window', async () => {
    const run = dispatched({ linked: false })
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('dispatched')
    advance(16 * MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'lost' })
    expect(get(run).stateReason).toMatch(/No workflow run named "hinomi fix corr-1"/)
  })
})

describe('rate limits and the request cap', () => {
  it('pauses when the rate limit runs low, until the window resets', async () => {
    dispatched()
    const reset = Math.floor(clock.getTime() / 1000) + 600
    world.headers = { 'x-ratelimit-remaining': '120', 'x-ratelimit-reset': String(reset) }
    const { tracker: t, requests } = tracker()
    const first = await t.tick()
    expect(first.pausedUntil?.getTime()).toBe(reset * 1000 + 1000)
    expect(first.nextDelayMs).toBe(601 * SECOND)
    const count = requests.length
    advance(60 * SECOND)
    expect((await t.tick()).polled).toBe(0)
    expect(requests.length).toBe(count)
  })

  it('pauses until retry-after when GitHub refuses with a long rate limit', async () => {
    const run = dispatched()
    world.runReply = {
      status: 403,
      headers: { 'retry-after': '120' },
      body: { message: 'secondary rate limit' },
    }
    const { tracker: t } = tracker()
    const summary = await t.tick()
    expect(summary.pausedUntil?.getTime()).toBe(clock.getTime() + 120 * SECOND)
    expect(t.status(get(run))?.lastError).toMatch(/rate limit/)
    expect(get(run).state).toBe('dispatched')
  })

  it('stops starting runs once the tick used its requests', async () => {
    const a = dispatched({ correlationId: 'corr-a' })
    // Another repo, so the first run is not superseded.
    const ledger = repos.repos.upsert({
      owner: 'kestrel-co',
      name: 'ledger',
      defaultBranch: 'main',
    })
    const ledgerPlan = saveRunnerPlan(repos, ledger, T0)
    const b = repos.fixRuns.create(
      {
        repoId: ledger.id,
        plan: { fixPlanId: ledgerPlan.id, scanRunId: ledgerPlan.scanRunId, version: 1 },
        runner: 'github_actions',
        kind: 'fix',
        correlationId: 'corr-b',
        checksMode: 'full',
      },
      clock,
    ).run
    repos.fixRuns.applyEvent(b.id, { type: 'dispatch_accepted', githubRunId: 7000 }, clock)
    const { tracker: t } = tracker({ config: { requestsPerTick: 1 } })
    const summary = await t.tick()
    expect(summary).toMatchObject({ polled: 1, requests: 1 })
    expect(t.status(get(a))?.lastPolledAt).toEqual(clock)
    expect(t.status(get(b))).toBeNull()
  })

  it('records why nothing was polled without a GitHub source', async () => {
    const run = dispatched()
    const { tracker: t } = tracker({
      github: () => ({ ok: false, message: 'Connect a GitHub source first.' }),
    })
    await t.tick()
    expect(t.status(get(run))).toMatchObject({ lastError: 'Connect a GitHub source first.' })
  })
})

describe('publishing', () => {
  function pushed() {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'success' }
    return run
  }

  it('retries a transient failure with backoff, then publishes', async () => {
    const run = pushed()
    world.createPull = { status: 502, body: { message: 'Bad Gateway' } }
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('branch_pushed')
    const status = t.status(get(run))
    expect(status?.lastError).toMatch(/502/)
    expect(status?.nextPollAt).toEqual(new Date(clock.getTime() + 30 * SECOND))

    world.createPull = null
    advance(10 * SECOND)
    expect((await t.tick()).polled).toBe(0)
    advance(20 * SECOND)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'pr_open', prNumber: 40 })
  })

  it('fails the run after too many transient failures', async () => {
    const run = pushed()
    world.createPull = { status: 502, body: { message: 'Bad Gateway' } }
    const { tracker: t } = tracker({ config: { publishMaxAttempts: 2 } })
    await t.tick()
    advance(MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'failed' })
    expect(get(run).stateReason).toMatch(/after 2 tries/)
  })

  it('fails the run on a refusal', async () => {
    const run = pushed()
    world.createPull = { status: 403, body: { message: 'Resource not accessible' } }
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('failed')
    expect(t.status(get(run))?.lastError).toMatch(/Pull requests: write/)
  })

  it('ends the run closed unmerged when the last fix PR was closed without asking', async () => {
    const run = pushed()
    world.pulls = [pull(12, { state: 'closed', closed_at: '2026-11-01T10:00:00Z' })]
    await tracker().tracker.tick()
    expect(get(run)).toMatchObject({ state: 'closed_unmerged', prNumber: 12 })
  })
})

describe('pull requests', () => {
  function withPr(state: 'pr_open' | 'checks_passing' = 'pr_open'): FixRunRow {
    const run = dispatched()
    repos.fixRuns.applyEvent(run.id, { type: 'branch_pushed', headSha: HEAD }, clock)
    repos.fixRuns.applyEvent(
      run.id,
      {
        type: 'pr_opened',
        number: 40,
        url: 'https://github.com/kestrel-co/harbor/pull/40',
        draft: false,
      },
      clock,
    )
    if (state === 'checks_passing') {
      repos.fixRuns.applyEvent(run.id, { type: 'checks_updated', status: 'passing' }, clock)
    }
    world.pulls = [pull(40)]
    return get(run)
  }

  it('reports pending checks right after the PR opens, then none', async () => {
    const run = withPr()
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('checks_pending')
    advance(11 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('checks_none')
  })

  it('reads a failing commit status next to passing check runs', async () => {
    const run = withPr()
    world.checkRuns = [{ status: 'completed', conclusion: 'success' }]
    world.status = { state: 'failure', total_count: 1 }
    await tracker().tracker.tick()
    expect(get(run).state).toBe('checks_failing')
  })

  it('uses the stored summaries when one checks source answers 304', async () => {
    const run = withPr()
    world.checkRuns = [{ status: 'completed', conclusion: 'success' }]
    world.status = { state: 'success', total_count: 1 }
    const { tracker: t, requests } = tracker()
    await t.tick()
    expect(get(run).state).toBe('checks_passing')
    world.status = { state: 'failure', total_count: 1 }
    advance(10 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('checks_failing')
    const checkReads = requests.filter((r) => r.path.includes('/check-runs'))
    expect(checkReads.map((r) => r.ifNoneMatch !== null)).toEqual([false, true])
  })

  it('follows the draft state and a close without merge', async () => {
    const run = withPr()
    world.pulls = [pull(40, { draft: true })]
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).prDraft).toBe(true)
    world.pulls = [pull(40, { state: 'closed', closed_at: clock.toISOString() })]
    advance(2 * MINUTE)
    await t.tick()
    expect(get(run).state).toBe('closed_unmerged')
  })

  it('notices a reopened PR on the slow poll of ended runs', async () => {
    const run = withPr('checks_passing')
    repos.fixRuns.applyEvent(run.id, { type: 'pr_closed' }, clock)
    world.pulls = [pull(40, { state: 'closed', closed_at: clock.toISOString() })]
    const { tracker: t } = tracker()
    await t.tick()
    expect(get(run).state).toBe('closed_unmerged')

    world.pulls = [pull(40)]
    world.checkRuns = [{ status: 'completed', conclusion: 'success' }]
    advance(10 * MINUTE)
    expect((await t.tick()).polled).toBe(0)
    advance(20 * MINUTE)
    await t.tick()
    expect(get(run)).toMatchObject({ state: 'checks_passing', closedAt: null, endedAt: null })
  })
})

describe('ended runs', () => {
  it('brings back a cancelled or failed run when GitHub re-runs it', async () => {
    for (const conclusion of ['cancelled', 'failure'] as const) {
      const run = dispatched()
      world.run = { ...world.run, run_attempt: 1, status: 'completed', conclusion }
      const { tracker: t } = tracker()
      await t.tick()
      expect(get(run).state).toBe(conclusion === 'cancelled' ? 'cancelled' : 'failed')

      advance(30 * MINUTE)
      await t.tick()
      expect(get(run).endedAt).not.toBeNull()

      world.run = { ...world.run, run_attempt: 2, status: 'in_progress', conclusion: null }
      advance(30 * MINUTE)
      await t.tick()
      expect(get(run)).toMatchObject({ state: 'running', githubRunAttempt: 2, endedAt: null })
      handle.sqlite.prepare('delete from fix_runs').run()
      clock = T0
    }
  })

  it('stops watching ended runs after seven days', async () => {
    const run = dispatched()
    world.run = { ...world.run, status: 'completed', conclusion: 'cancelled' }
    const { tracker: t, requests } = tracker()
    await t.tick()
    advance(FIX_RUN_TRACKING.endedForMs + MINUTE)
    const count = requests.length
    await t.tick()
    expect(requests.length).toBe(count)
    expect(t.status(get(run))).toBeNull()
  })
})
