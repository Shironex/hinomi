import type { FixResultV1 } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixPlanRow, FixRunRow, RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { openRunnerGithub } from './github.js'
import { publishFixPr, type FixPrPublisherOptions } from './publisher.js'
import { createFixRunService } from './service.js'
import {
  connectGithubToken,
  fakeGithub,
  repoReply,
  runnerResult,
  saveRunnerPlan,
  type FakeReply,
  type FakeRequest,
} from './testing.js'

// Opening and updating the fix PR (mode A) against a fake GitHub that keeps its pull requests.
// Every org, repo and URL here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const T1 = new Date('2026-11-07T11:00:00.000Z')
const T2 = new Date('2026-11-07T12:00:00.000Z')
const HEAD = 'c'.repeat(40)
const BASE_URL = 'https://hinomi.example.dev'
const API_REPO = '/repos/Kestrel-Co/Harbor'

interface FakePull {
  number: number
  node_id: string
  html_url: string
  state: 'open' | 'closed'
  draft: boolean
  title: string
  body: string
  merged_at: string | null
  closed_at: string | null
  labels: { name: string }[]
  head: { ref: string; sha: string }
  base: { ref: string }
}

type Failure = 'create' | 'update' | 'graphql' | 'addLabels'

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

function pull(number: number, overrides: Partial<FakePull> = {}): FakePull {
  return {
    number,
    node_id: `PR_node${number}`,
    html_url: `https://github.com/Kestrel-Co/Harbor/pull/${number}`,
    state: 'open',
    draft: false,
    title: 'fix(deps): an older title',
    body: `older body\n<!-- hinomi:fix repo=${harbor.id} plan=1 run=old schema=1 -->`,
    merged_at: null,
    closed_at: null,
    labels: [],
    head: { ref: 'hinomi/fix-plan', sha: 'd'.repeat(40) },
    base: { ref: 'main' },
    ...overrides,
  }
}

/** A fake GitHub with a list of pull requests and labels it changes as Hinomi writes. */
function github(
  options: {
    visibility?: 'public' | 'private'
    pulls?: FakePull[]
    labels?: string[]
    fail?: Partial<Record<Failure, FakeReply>>
  } = {},
) {
  const pulls = options.pulls ?? []
  const labels = options.labels ?? ['dependencies', 'security']
  const fail = options.fail ?? {}
  let next = 40
  const query = (request: FakeRequest) => new URL(`https://x${request.path}`).searchParams
  const fake = fakeGithub([
    {
      path: '/repos/kestrel-co/harbor',
      reply: repoReply('Kestrel-Co', 'Harbor', options.visibility ?? 'public'),
    },
    {
      path: /^\/repos\/Kestrel-Co\/Harbor\/pulls\?/,
      reply: (request) => {
        const q = query(request)
        const [owner, branch] = (q.get('head') ?? '').split(':')
        const body = pulls.filter(
          (p) =>
            p.state === q.get('state') &&
            owner === 'Kestrel-Co' &&
            p.head.ref === branch &&
            p.base.ref === q.get('base'),
        )
        return { body }
      },
    },
    {
      method: 'POST',
      path: `${API_REPO}/pulls`,
      reply: (request) => {
        if (fail.create) return fail.create
        const sent = request.body as { title: string; body: string; head: string; draft: boolean }
        const created = pull(next++, {
          title: sent.title,
          body: sent.body,
          draft: sent.draft,
          head: { ref: sent.head, sha: HEAD },
        })
        pulls.push(created)
        return { status: 201, body: created }
      },
    },
    {
      method: 'PATCH',
      path: /^\/repos\/Kestrel-Co\/Harbor\/pulls\/\d+$/,
      reply: (request) => {
        if (fail.update) return fail.update
        const number = Number(request.path.split('/').pop())
        const target = pulls.find((p) => p.number === number)
        if (!target) return { status: 404, body: { message: 'Not Found' } }
        Object.assign(target, request.body)
        return { body: target }
      },
    },
    {
      method: 'POST',
      path: '/graphql',
      reply: (request) => {
        if (fail.graphql) return fail.graphql
        const sent = request.body as { query: string; variables: { id: string } }
        const target = pulls.find((p) => p.node_id === sent.variables.id)
        if (!target) return { body: { errors: [{ type: 'NOT_FOUND', message: 'no PR' }] } }
        target.draft = sent.query.includes('convertPullRequestToDraft')
        return { body: { data: { result: { pullRequest: { isDraft: target.draft } } } } }
      },
    },
    {
      path: /^\/repos\/Kestrel-Co\/Harbor\/labels\/[^/]+$/,
      reply: (request) => {
        const name = decodeURIComponent(request.path.split('/').pop() ?? '')
        return labels.includes(name)
          ? { body: { name } }
          : { status: 404, body: { message: 'Not Found' } }
      },
    },
    {
      method: 'POST',
      path: /^\/repos\/Kestrel-Co\/Harbor\/issues\/\d+\/labels$/,
      reply: (request) => {
        if (fail.addLabels) return fail.addLabels
        const number = Number(request.path.split('/')[5])
        const target = pulls.find((p) => p.number === number)
        const added = (request.body as { labels: string[] }).labels
        target?.labels.push(...added.map((name) => ({ name })))
        return { body: target?.labels ?? [] }
      },
    },
  ])
  return { ...fake, pulls }
}

function publisher(
  fake: ReturnType<typeof github>,
  options: Partial<FixPrPublisherOptions> = {},
  now = T1,
): FixPrPublisherOptions {
  return {
    repositories: repos,
    github: () => openRunnerGithub(repos, { fetch: fake.fetch }),
    now: () => now,
    ...options,
  }
}

let correlation = 0

/** A run of the latest plan, dispatched and running, created at `at`. */
function runningRun(at = T0, plan?: FixPlanRow): { run: FixRunRow; result: FixResultV1 } {
  const row = plan ?? saveRunnerPlan(repos, harbor, at)
  const correlationId = `run-${++correlation}`
  const { run } = repos.fixRuns.create(
    {
      repoId: harbor.id,
      plan: { fixPlanId: row.id, scanRunId: row.scanRunId, version: row.version },
      runner: 'github_actions',
      kind: 'fix',
      correlationId,
      checksMode: 'full',
    },
    at,
  )
  repos.fixRuns.applyEvent(run.id, { type: 'dispatch_accepted', githubRunId: 9000 + run.id }, at)
  repos.fixRuns.applyEvent(run.id, { type: 'run_started' }, at)
  const result = runnerResult(row.plan, correlationId, { repo: 'Kestrel-Co/Harbor' })
  return { run: repos.fixRuns.get(run.id)!, result }
}

function failing(result: FixResultV1): FixResultV1 {
  return {
    ...result,
    checks: result.checks.map((c) => ({ ...c, status: 'failed', output: 'FAIL harbor.test.ts' })),
  }
}

const writes = (requests: FakeRequest[]) =>
  requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`)

describe('publishFixPr: a new PR', () => {
  it('opens a ready PR from the pushed branch and records the push and the PR', async () => {
    const fake = github({ labels: ['dependencies', 'good first issue'] })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)

    expect(outcome).toMatchObject({
      kind: 'published',
      action: 'created',
      replaces: null,
      labelsAdded: ['dependencies'],
      warnings: [],
      pr: { number: 40, url: 'https://github.com/Kestrel-Co/Harbor/pull/40', draft: false },
    })
    const create = fake.requests.find((r) => r.method === 'POST' && r.path === `${API_REPO}/pulls`)
    expect(create?.body).toMatchObject({
      head: 'hinomi/fix-plan',
      base: 'main',
      draft: false,
      maintainer_can_modify: false,
      title: 'fix(deps): clear 2 findings in 2 packages (2 exposed)',
    })
    // Only labels the repo has; Hinomi never creates one.
    expect(writes(fake.requests)).toEqual([
      `POST ${API_REPO}/pulls`,
      `POST ${API_REPO}/issues/40/labels`,
    ])
    expect(fake.requests.find((r) => r.path.endsWith('/issues/40/labels'))?.body).toEqual({
      labels: ['dependencies'],
    })
    const row = repos.fixRuns.get(run.id)
    expect(row).toMatchObject({
      state: 'pr_open',
      headSha: HEAD,
      prNumber: 40,
      prUrl: 'https://github.com/Kestrel-Co/Harbor/pull/40',
      prDraft: false,
    })
    expect(row?.pushedAt).toEqual(T1)
    expect(row?.prOpenedAt).toEqual(T1)
  })

  it('opens a draft when a check failed', async () => {
    const fake = github()
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, failing(result), HEAD)

    expect(outcome).toMatchObject({ kind: 'published', pr: { draft: true } })
    expect(fake.pulls[0]?.draft).toBe(true)
    expect(fake.pulls[0]?.body).toContain('### Failed checks')
    expect(repos.fixRuns.get(run.id)?.prDraft).toBe(true)
  })

  it('never links a public repo back to Hinomi, even with a public base URL', async () => {
    const fake = github({ visibility: 'public' })
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake, { publicBaseUrl: () => BASE_URL }), run, result, HEAD)
    expect(fake.pulls[0]?.body).not.toContain('hinomi.example.dev')
    expect(fake.pulls[0]?.body).not.toContain('Open this fix run in Hinomi')
  })

  it('links a private repo to the fix run when a public base URL is set', async () => {
    const fake = github({ visibility: 'private' })
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake, { publicBaseUrl: () => BASE_URL }), run, result, HEAD)
    expect(fake.pulls[0]?.body).toContain(
      `[Open this fix run in Hinomi](${BASE_URL}/fix-runs?sel=${run.id})`,
    )
  })

  it('leaves the link out of a private repo without a public base URL', async () => {
    const fake = github({ visibility: 'private' })
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake, { publicBaseUrl: () => null }), run, result, HEAD)
    expect(fake.pulls[0]?.body).not.toContain('Open this fix run in Hinomi')
  })
})

describe('publishFixPr: an open PR', () => {
  it('changes nothing when the same result is published twice', async () => {
    const fake = github()
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake), run, result, HEAD)
    const after = repos.fixRuns.get(run.id)!
    const sent = fake.requests.length

    const again = await publishFixPr(publisher(fake, {}, T2), after, result, HEAD)
    expect(again).toMatchObject({ kind: 'published', action: 'unchanged', labelsAdded: [] })
    expect(writes(fake.requests.slice(sent))).toEqual([])
    expect(fake.pulls).toHaveLength(1)
    expect(repos.fixRuns.get(run.id)).toEqual(after)
  })

  it('takes over the open PR of an earlier run and marks it ready for review', async () => {
    const fake = github({ pulls: [pull(7, { draft: true, labels: [{ name: 'security' }] })] })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)

    expect(outcome).toMatchObject({
      kind: 'published',
      action: 'updated',
      pr: { number: 7, draft: false },
      labelsAdded: ['dependencies'],
    })
    const patch = fake.requests.find((r) => r.method === 'PATCH')
    expect(patch?.path).toBe(`${API_REPO}/pulls/7`)
    expect(patch?.body).toMatchObject({
      title: 'fix(deps): clear 2 findings in 2 packages (2 exposed)',
    })
    const graphql = fake.requests.find((r) => r.path === '/graphql')
    expect((graphql?.body as { query: string }).query).toContain('markPullRequestReadyForReview')
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === `${API_REPO}/pulls`)).toBe(
      false,
    )
    expect(repos.fixRuns.get(run.id)).toMatchObject({
      state: 'pr_open',
      prNumber: 7,
      prDraft: false,
    })
  })

  it('turns a ready PR back into a draft when checks fail', async () => {
    const fake = github({ pulls: [pull(7)] })
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake), run, result, HEAD)
    const graphqlBefore = fake.requests.filter((r) => r.path === '/graphql').length
    expect(graphqlBefore).toBe(0)

    const opened = repos.fixRuns.get(run.id)!
    const outcome = await publishFixPr(publisher(fake), opened, failing(result), HEAD)
    expect(outcome).toMatchObject({ kind: 'published', action: 'updated', pr: { draft: true } })
    const graphql = fake.requests.filter((r) => r.path === '/graphql')
    expect((graphql[0]?.body as { query: string }).query).toContain('convertPullRequestToDraft')
    expect(repos.fixRuns.get(run.id)?.prDraft).toBe(true)
  })

  it('prefers the PR with the Hinomi marker over another open PR of the branch', async () => {
    const other = pull(5, { body: 'opened by hand' })
    const fake = github({ pulls: [other, pull(9)] })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'published', pr: { number: 9 } })
  })

  it('keeps the PR as it is and warns when the draft state cannot be changed', async () => {
    const fake = github({
      pulls: [pull(7, { draft: true })],
      fail: {
        graphql: { body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] } },
      },
    })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'published', pr: { number: 7, draft: true } })
    if (outcome.kind !== 'published') throw new Error('expected published')
    expect(outcome.warnings[0]).toContain('could not be marked ready for review')
    expect(repos.fixRuns.get(run.id)).toMatchObject({ state: 'pr_open', prDraft: true })
  })

  it('warns instead of failing when labels cannot be added', async () => {
    const fake = github({ fail: { addLabels: { status: 403, body: { message: 'Forbidden' } } } })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'published', action: 'created', labelsAdded: [] })
    if (outcome.kind !== 'published') throw new Error('expected published')
    expect(outcome.warnings[0]).toContain('labels could not be added')
  })
})

describe('publishFixPr: a closed unmerged PR (decision 10)', () => {
  it('does not reopen silently: the run ends closed unmerged with that PR', async () => {
    const closed = pull(7, { state: 'closed', closed_at: '2026-11-06T09:00:00Z' })
    const fake = github({ pulls: [closed] })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)

    expect(outcome).toMatchObject({ kind: 'reopen_required', previous: { number: 7 } })
    expect(writes(fake.requests)).toEqual([])
    expect(repos.fixRuns.get(run.id)).toMatchObject({ state: 'closed_unmerged', prNumber: 7 })
    // The next dispatch asks first.
    expect(repos.fixRuns.closedUnmergedPrevious(harbor.id, 'fix')?.id).toBe(run.id)
  })

  it('opens a fresh PR that names the closed one once the dispatch was confirmed', async () => {
    const closed = pull(7, { state: 'closed', closed_at: '2026-11-06T09:00:00Z' })
    const fake = github({ pulls: [closed] })
    const first = runningRun(T0)
    await publishFixPr(publisher(fake, {}, T0), first.run, first.result, HEAD)

    // The UI asked and the person confirmed; the dispatch created a newer run.
    const plan = repos.fixPlans.forRepo(harbor.id)!
    const second = runningRun(T1, plan)
    const outcome = await publishFixPr(publisher(fake, {}, T2), second.run, second.result, HEAD)

    expect(outcome).toMatchObject({
      kind: 'published',
      action: 'created',
      replaces: 7,
      pr: { number: 40 },
    })
    expect(fake.pulls.find((p) => p.number === 40)?.body).toContain(
      'Replaces #7, which was closed without merging.',
    )
    expect(closed.state).toBe('closed')
    expect(repos.fixRuns.get(second.run.id)).toMatchObject({ state: 'pr_open', prNumber: 40 })
  })

  it('opens a fresh PR without asking when the last PR was merged', async () => {
    const merged = pull(7, {
      state: 'closed',
      closed_at: '2026-11-06T09:00:00Z',
      merged_at: '2026-11-06T09:00:00Z',
    })
    const fake = github({ pulls: [merged] })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'published', action: 'created', replaces: null })
    expect(fake.pulls.find((p) => p.number === 40)?.body).not.toContain('Replaces')
  })

  it('records the close when a person closed the PR this run opened', async () => {
    const fake = github()
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake), run, result, HEAD)
    fake.pulls[0]!.state = 'closed'
    fake.pulls[0]!.closed_at = '2026-11-07T11:30:00Z'

    const opened = repos.fixRuns.get(run.id)!
    const outcome = await publishFixPr(publisher(fake, {}, T2), opened, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'reopen_required', previous: { number: 40 } })
    expect(repos.fixRuns.get(run.id)?.state).toBe('closed_unmerged')
    expect(fake.pulls).toHaveLength(1)
  })
})

describe('publishFixPr: refusals', () => {
  const cases: [string, FakeReply, RegExp][] = [
    [
      '403',
      { status: 403, body: { message: 'Resource not accessible by integration' } },
      /Pull requests: write/,
    ],
    ['404', { status: 404, body: { message: 'Not Found' } }, /answered 404/],
    [
      '422 without commits',
      {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'No commits between main and hinomi/fix-plan' }],
        },
      },
      /no commits ahead of main/,
    ],
    [
      '422 without the branch',
      {
        status: 422,
        body: { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] },
      },
      /found no branch hinomi\/fix-plan/,
    ],
  ]

  it.each(cases)(
    'fails the run with a clear reason on %s, without retrying',
    async (_, reply, reason) => {
      const fake = github({ fail: { create: reply } })
      const { run, result } = runningRun()
      const outcome = await publishFixPr(publisher(fake), run, result, HEAD)

      expect(outcome.kind).toBe('failed')
      if (outcome.kind !== 'failed') throw new Error('expected failed')
      expect(outcome.reason).toMatch(reason)
      expect(writes(fake.requests)).toEqual([`POST ${API_REPO}/pulls`])
      const row = repos.fixRuns.get(run.id)
      expect(row?.state).toBe('failed')
      expect(row?.stateReason).toMatch(reason)
      expect(row?.headSha).toBe(HEAD)
    },
  )

  it('leaves the run for another try after a 5xx, without repeating the write', async () => {
    const fake = github({ fail: { create: { status: 502, body: { message: 'Bad Gateway' } } } })
    const { run, result } = runningRun()
    const outcome = await publishFixPr(publisher(fake), run, result, HEAD)

    expect(outcome.kind).toBe('retry')
    expect(writes(fake.requests)).toEqual([`POST ${API_REPO}/pulls`])
    expect(repos.fixRuns.get(run.id)?.state).toBe('branch_pushed')
  })

  it('reports a failed update without moving a run that already has its PR', async () => {
    const fake = github()
    const { run, result } = runningRun()
    await publishFixPr(publisher(fake), run, result, HEAD)
    const opened = repos.fixRuns.get(run.id)!
    const broken = github({
      pulls: fake.pulls,
      fail: { update: { status: 403, body: { message: 'Forbidden' } } },
    })
    const outcome = await publishFixPr(publisher(broken), opened, failing(result), HEAD)
    expect(outcome.kind).toBe('failed')
    expect(repos.fixRuns.get(run.id)?.state).toBe('pr_open')
  })

  it('refuses a result of another run', async () => {
    const fake = github()
    const { run, result } = runningRun()
    const outcome = await publishFixPr(
      publisher(fake),
      run,
      { ...result, runId: 'run-other' },
      HEAD,
    )
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(writes(fake.requests)).toEqual([])
    expect(repos.fixRuns.get(run.id)?.state).toBe('failed')
  })

  it('skips a run that ended, without asking GitHub', async () => {
    const fake = github()
    const { run, result } = runningRun()
    repos.fixRuns.applyEvent(run.id, { type: 'failed', reason: 'run_failure' }, T0)
    const ended = repos.fixRuns.get(run.id)!
    const outcome = await publishFixPr(publisher(fake), ended, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'skipped' })
    expect(fake.requests).toEqual([])
  })
})

describe('FixRunService.publishFixPr', () => {
  it('links private repos with the configured public base URL', async () => {
    const fake = github({ visibility: 'private' })
    const service = createFixRunService({
      repositories: repos,
      fetch: fake.fetch,
      now: () => T1,
      publicBaseUrl: () => BASE_URL,
    })
    const { run, result } = runningRun()
    const outcome = await service.publishFixPr(run, result, HEAD)
    expect(outcome).toMatchObject({ kind: 'published', action: 'created' })
    expect(fake.pulls[0]?.body).toContain(`${BASE_URL}/fix-runs?sel=${run.id}`)
  })
})
