import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  GITHUB_WEBHOOK_PATH,
  githubWebhookSettingsSchema,
} from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixRunRow, RepoRow } from '../db/schema.js'
import { createSecretBox } from '../crypto/secret-box.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { createFixRunTracker, type FixRunTracker } from '../runner/index.js'
import { saveRunnerPlan } from '../runner/testing.js'
import { createGithubWebhookReceiver, type GithubWebhookReceiver } from './receiver.js'
import { WEBHOOK_SETTING_KEYS } from './settings.js'
import { signGithubPayload, verifyGithubSignature } from './signature.js'

// The webhook receiver against the real tracker's pollNow, on an in-memory database. Every org,
// repo and id here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const HEAD = 'c'.repeat(40)
const URL_ = `https://hinomi.example.dev${GITHUB_WEBHOOK_PATH}`

let handle: DatabaseHandle
let repos: Repositories
let tracker: FixRunTracker
let receiver: GithubWebhookReceiver
let polled: number[][]
let secret: string
let deliveryCount: number

function makeRun(
  repo: RepoRow,
  correlationId: string,
  steps: { githubRunId?: number | null; pr?: number } = {},
): FixRunRow {
  const plan = saveRunnerPlan(repos, repo, T0)
  const { run } = repos.fixRuns.create(
    {
      repoId: repo.id,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
      runner: 'github_actions',
      kind: 'fix',
      correlationId,
      checksMode: 'full',
    },
    T0,
  )
  repos.fixRuns.applyEvent(
    run.id,
    { type: 'dispatch_accepted', githubRunId: steps.githubRunId ?? null },
    T0,
  )
  if (steps.pr !== undefined) {
    repos.fixRuns.applyEvent(run.id, { type: 'branch_pushed', headSha: HEAD }, T0)
    repos.fixRuns.applyEvent(
      run.id,
      {
        type: 'pr_opened',
        number: steps.pr,
        url: `https://github.com/kestrel-co/${repo.name}/pull/${steps.pr}`,
        draft: false,
      },
      T0,
    )
  }
  const row = repos.fixRuns.get(run.id)
  if (!row) throw new Error('run gone')
  return row
}

let linked: FixRunRow
let unlinked: FixRunRow
let withPr: FixRunRow

beforeEach(() => {
  const test = createTestRepositories()
  handle = test.handle
  repos = test.repos
  const harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  const ledger = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger', defaultBranch: 'main' })
  const quay = repos.repos.upsert({ owner: 'kestrel-co', name: 'quay', defaultBranch: 'trunk' })
  linked = makeRun(harbor, 'corr-h', { githubRunId: 9001 })
  unlinked = makeRun(ledger, 'corr-l')
  withPr = makeRun(quay, 'corr-q', { githubRunId: 9002, pr: 40 })
  tracker = createFixRunTracker({
    repositories: repos,
    now: () => T0,
    github: () => ({ ok: false, message: 'no GitHub in these tests' }),
  })
  polled = []
  deliveryCount = 0
  receiver = createGithubWebhookReceiver({
    repositories: repos,
    secretBox: createSecretBox(TEST_SECRET),
    now: () => T0,
    pollNow: (select) => {
      const ids = tracker.pollNow(select)
      polled.push(ids)
      return ids
    },
  })
  secret = receiver.settings.rotate(T0)
  receiver.settings.update({ enabled: true })
})
afterEach(() => handle.close())

interface Send {
  event?: string
  body?: unknown
  raw?: string
  signWith?: string | null
  signature?: string
  delivery?: string
  contentType?: string
  headers?: Record<string, string>
}

async function send(options: Send = {}) {
  const raw = options.raw ?? JSON.stringify(options.body ?? {})
  deliveryCount += 1
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
    'x-github-event': options.event ?? 'ping',
    'x-github-delivery': options.delivery ?? `0000000${deliveryCount}-aaaa-bbbb-cccc-000000000000`,
    ...options.headers,
  }
  const key = options.signWith === undefined ? secret : options.signWith
  if (options.signature !== undefined) headers['x-hub-signature-256'] = options.signature
  else if (key !== null) headers['x-hub-signature-256'] = signGithubPayload(key, raw)
  const res = await receiver.handle(new Request(URL_, { method: 'POST', headers, body: raw }))
  await receiver.idle()
  const text = await res.text()
  return { status: res.status, text, json: text ? (JSON.parse(text) as unknown) : undefined }
}

const repository = (name: string, defaultBranch = 'main') => ({
  repository: { full_name: `kestrel-co/${name}`, default_branch: defaultBranch },
})

describe('signature', () => {
  it("verifies GitHub's documented example", () => {
    // From https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    const body = new TextEncoder().encode('Hello, World!')
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
    expect(verifyGithubSignature("It's a Secret to Everybody", body, header)).toBe(true)
    expect(verifyGithubSignature('another secret', body, header)).toBe(false)
    expect(verifyGithubSignature("It's a Secret to Everybody", body, undefined)).toBe(false)
    expect(verifyGithubSignature("It's a Secret to Everybody", body, 'sha1=abc')).toBe(false)
    expect(verifyGithubSignature("It's a Secret to Everybody", body, header.slice(0, -2))).toBe(
      false,
    )
  })
})

describe('receiving', () => {
  it('accepts a ping with a valid signature and records the delivery', async () => {
    const res = await send({ event: 'ping', body: { zen: 'Keep it logically awesome.' } })
    expect(res).toMatchObject({ status: 202, json: { status: 'accepted' } })
    expect(receiver.view()).toMatchObject({
      lastDeliveryAt: T0.toISOString(),
      lastDeliveryEvent: 'ping',
      lastError: null,
    })
    expect(polled).toEqual([])
  })

  it('rejects a missing, malformed or invalid signature with 401 and no body', async () => {
    for (const options of [
      { signWith: null },
      { signature: 'sha256=zz' },
      { signature: `sha256=${'0'.repeat(64)}` },
      { signWith: 'not-the-secret' },
    ] satisfies Send[]) {
      const res = await send({ event: 'workflow_run', ...options })
      expect(res).toEqual({ status: 401, text: '', json: undefined })
    }
    expect(receiver.view().lastError).toMatch(/invalid signature/)
    expect(receiver.view().lastDeliveryAt).toBeNull()
    expect(polled).toEqual([])
  })

  it('rejects the old secret after a rotation', async () => {
    const old = secret
    secret = receiver.settings.rotate(T0)
    expect(secret).not.toBe(old)
    expect((await send({ signWith: old })).status).toBe(401)
    expect((await send()).status).toBe(202)
  })

  it('treats the same delivery id again as a replay', async () => {
    const body = { ...repository('harbor'), workflow_run: { id: 9001 } }
    const delivery = '72d3162e-cc78-11e3-81ab-4c9367dc0958'
    expect((await send({ event: 'workflow_run', body, delivery })).status).toBe(202)
    const again = await send({ event: 'workflow_run', body, delivery })
    expect(again).toMatchObject({ status: 200, json: { status: 'duplicate' } })
    expect(polled).toEqual([[linked.id]])
  })

  it('refuses a body over the cap, declared or streamed', async () => {
    const big = 'x'.repeat(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1)
    expect((await send({ raw: big })).status).toBe(413)
    const declared = await receiver.handle(
      new Request(URL_, {
        method: 'POST',
        headers: { 'content-length': String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) },
        body: '{}',
      }),
    )
    expect(declared.status).toBe(413)
    const chunk = new Uint8Array(256 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        if (sent > 8) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const streamed = await receiver.handle(
      new Request(URL_, { method: 'POST', body: stream, duplex: 'half' }),
    )
    expect(streamed.status).toBe(413)
    expect(sent).toBeLessThan(8)
  })

  it('ignores an event it does not follow, and push unless it is on', async () => {
    expect(await send({ event: 'issues', body: repository('harbor') })).toMatchObject({
      status: 202,
      json: { status: 'ignored' },
    })
    const push = { ...repository('harbor'), ref: 'refs/heads/hinomi/fix-plan', after: HEAD }
    expect(await send({ event: 'push', body: push })).toMatchObject({
      json: { status: 'ignored' },
    })
    expect(polled).toEqual([])
    receiver.settings.update({ includePush: true })
    expect(await send({ event: 'push', body: push })).toMatchObject({
      json: { status: 'accepted' },
    })
    expect(polled).toEqual([[linked.id]])
    expect(receiver.view().events).toContain('push')
  })

  it('wants JSON, the event and delivery headers, and a parseable body', async () => {
    expect((await send({ contentType: 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect((await send({ delivery: '' })).status).toBe(400)
    expect((await send({ raw: '{not json' })).status).toBe(400)
    expect((await send({ event: 'workflow_run', body: repository('harbor') })).json).toEqual({
      status: 'ignored',
    })
    expect(receiver.view().lastError).toMatch(/missing fields/)
  })

  it('answers 404 like an unknown route while off, and records nothing', async () => {
    receiver.settings.update({ enabled: false })
    const res = await send()
    expect(res).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } })
    expect(receiver.view().lastDeliveryAt).toBeNull()
  })

  it('answers 404 when the secret cannot be decrypted', async () => {
    const keyless = createGithubWebhookReceiver({
      repositories: repos,
      secretBox: null,
      pollNow: () => [],
    })
    const raw = '{}'
    const res = await keyless.handle(
      new Request(URL_, {
        method: 'POST',
        headers: { 'x-hub-signature-256': signGithubPayload(secret, raw) },
        body: raw,
      }),
    )
    expect(res.status).toBe(404)
    expect(keyless.view()).toMatchObject({ canStoreSecret: false, lastError: /cannot be read/ })
  })

  it('stores the secret encrypted and never shows it again', () => {
    const stored = JSON.stringify(repos.settings.all()[WEBHOOK_SETTING_KEYS.config])
    expect(stored).not.toContain(secret)
    expect(stored).toMatch(/"secret":"v1\./)
    const view = githubWebhookSettingsSchema.parse(receiver.view())
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(view).toMatchObject({ enabled: true, secretSet: true, path: GITHUB_WEBHOOK_PATH })
  })
})

describe('mapping deliveries to runs', () => {
  it('ignores a repo Hinomi does not track', async () => {
    const body = { ...repository('elsewhere'), workflow_run: { id: 9001 } }
    expect((await send({ event: 'workflow_run', body })).json).toEqual({ status: 'accepted' })
    expect(polled).toEqual([])
  })

  it.each([
    ['workflow_run by id', 'workflow_run', 'harbor', { workflow_run: { id: 9001 } }, 'linked'],
    [
      'workflow_run by run name',
      'workflow_run',
      'ledger',
      { workflow_run: { id: 777, display_title: 'hinomi fix corr-l' } },
      'unlinked',
    ],
    [
      'pull_request by number',
      'pull_request',
      'quay',
      { number: 40, pull_request: { head: { ref: 'feature', sha: 'f'.repeat(40) } } },
      'withPr',
    ],
    [
      'pull_request by branch before the PR is known',
      'pull_request',
      'ledger',
      { number: 41, pull_request: { head: { ref: 'hinomi/fix-plan', sha: 'f'.repeat(40) } } },
      'unlinked',
    ],
    [
      'check_suite by head sha',
      'check_suite',
      'quay',
      { check_suite: { head_sha: HEAD, head_branch: null, pull_requests: [] } },
      'withPr',
    ],
    [
      'check_run by PR number',
      'check_run',
      'quay',
      { check_run: { head_sha: 'f'.repeat(40), pull_requests: [{ number: 40 }] } },
      'withPr',
    ],
    ['status by sha', 'status', 'quay', { sha: HEAD, branches: [] }, 'withPr'],
  ] as const)('polls the run a %s names', async (_label, event, repo, payload, expected) => {
    const res = await send({ event, body: { ...repository(repo), ...payload } })
    expect(res).toMatchObject({ status: 202, json: { status: 'accepted' } })
    const runs = { linked, unlinked, withPr }
    expect(polled).toEqual([[runs[expected].id]])
  })

  it('polls nothing when no run matches', async () => {
    await send({
      event: 'workflow_run',
      body: { ...repository('harbor'), workflow_run: { id: 1, display_title: 'CI' } },
    })
    await send({ event: 'status', body: { ...repository('quay'), sha: 'f'.repeat(40) } })
    expect(polled).toEqual([[], []])
  })

  it('polls runs with a PR on a push to the default branch', async () => {
    receiver.settings.update({ includePush: true })
    const body = { ...repository('quay', 'trunk'), ref: 'refs/heads/trunk', after: 'e'.repeat(40) }
    await send({ event: 'push', body })
    expect(polled).toEqual([[withPr.id]])
  })

  it('leaves the state to the poll: a delivery changes no run', async () => {
    const before = repos.fixRuns.get(withPr.id)
    await send({
      event: 'pull_request',
      body: {
        ...repository('quay'),
        action: 'closed',
        number: 40,
        pull_request: { merged: true, head: { ref: 'hinomi/fix-plan', sha: HEAD } },
      },
    })
    expect(repos.fixRuns.get(withPr.id)).toEqual(before)
  })
})
