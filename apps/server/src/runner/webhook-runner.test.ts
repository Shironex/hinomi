import { decodeFixDispatch, type WebhookDispatchBody } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { zlibCompressor } from './compressor.js'
import { openRunnerGithub } from './github.js'
import { connectGithubToken, fakeGithub, repoReply, saveRunnerPlan } from './testing.js'
import { WebhookRunner, type WebhookDelivery } from './webhook-runner.js'

// The webhook runner against a fake GitHub and a fake delivery. Every repo here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const RUN_ID = 'run-7c1d02'

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
  answer: { ok: true } | { ok: false; reason: string },
  problem: string | null = null,
) {
  const sent: Omit<WebhookDispatchBody, 'callbackUrl'>[] = []
  const delivery: WebhookDelivery = {
    problem: () => problem,
    deliver: (payload) => {
      sent.push(payload)
      return Promise.resolve(answer)
    },
  }
  const github = fakeGithub([
    { path: '/repos/kestrel-co/harbor', reply: repoReply('Kestrel-Co', 'Harbor', 'private') },
  ])
  const runner = new WebhookRunner({
    repositories: repos,
    github: (repoId) => openRunnerGithub(repos, repoId, { fetch: github.fetch }),
    delivery,
    now: () => T0,
    correlationId: () => RUN_ID,
  })
  return { runner, sent, requests: github.requests }
}

describe('WebhookRunner.dispatch', () => {
  it('posts the encoded plan with the run id, the branch and the repo as GitHub spells it', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, sent } = setup({ ok: true })
    const outcome = await runner.dispatch({ repo: harbor, plan })

    expect(sent).toHaveLength(1)
    const body = sent[0]
    expect(body).toMatchObject({
      schema: 'hinomi.webhook-dispatch/1',
      runId: RUN_ID,
      kind: 'fix',
      repo: 'Kestrel-Co/Harbor',
      branch: 'hinomi/fix-plan',
      encoding: 'json',
    })
    const dispatch = await decodeFixDispatch(body?.plan ?? '', body?.encoding ?? 'json', {
      compressor: zlibCompressor,
    })
    expect(dispatch.runId).toBe(RUN_ID)
    expect(dispatch.options.checks).toBe('install')
    expect(outcome.created).toBe(true)
    if (!outcome.created) return
    expect(outcome.run).toMatchObject({
      runner: 'webhook',
      state: 'dispatched',
      correlationId: RUN_ID,
      githubRunId: null,
    })
  })

  it('sends a majors run to the majors branch', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, sent } = setup({ ok: true })
    const outcome = await runner.dispatch({ repo: harbor, plan, kind: 'majors' })
    expect(sent[0]).toMatchObject({ kind: 'majors', branch: 'hinomi/majors' })
    expect(outcome.created && outcome.run.kind).toBe('majors')
  })

  it('fails the run with the reason when the runner refuses the plan', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const reason = 'The webhook runner at runner.example.dev refused the plan with HTTP 500.'
    const { runner } = setup({ ok: false, reason })
    const outcome = await runner.dispatch({ repo: harbor, plan })
    expect(outcome.created && outcome.run.state).toBe('failed')
    expect(outcome.created && outcome.run.stateReason).toBe(reason)
  })

  it('refuses before creating a run while the webhook runner is not set up', async () => {
    const plan = saveRunnerPlan(repos, harbor, T0)
    const { runner, sent, requests } = setup({ ok: true }, 'Set the webhook runner URL first.')
    const outcome = await runner.dispatch({ repo: harbor, plan })
    expect(outcome).toEqual({
      created: false,
      code: 'not_configured',
      message: 'Set the webhook runner URL first.',
    })
    expect(sent).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(repos.fixRuns.listByRepo(harbor.id)).toHaveLength(0)
  })
})
