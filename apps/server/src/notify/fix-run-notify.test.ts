import { DEFAULT_FIX_RUN_NOTIFY_EVENTS, type FixRunVerification } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import { createSecretBox } from '../crypto/secret-box.js'
import type { CreateFixRunInput, FixRunEvent, Repositories } from '../repository/index.js'
import type { ResolvedEmail } from './channels.js'
import type { MailMessage } from './email.js'
import { createNotifier, type Notifier } from './notifier.js'
import { readFixRunEvents, writePublicBaseUrl, writeFixRunEvents } from './settings.js'

// Every repo, host and URL here is fictional.

const DISCORD_URL = 'https://discord.com/api/webhooks/1234567890/SECRETTOKENabcdefghijklmnop0123'
const HOOK_URL = 'https://hooks.example.dev/in/SECRET-PATH-0123456789'
const PR_URL = 'https://github.com/kestrel-co/storefront/pull/42'
const BASE_URL = 'https://hinomi.example.dev'
const T0 = new Date('2026-11-07T08:00:00.000Z')

interface Embed {
  title: string
  url?: string
  fields: { name: string; value: string }[]
}
interface Call {
  url: string
  body: Record<string, unknown> & { embeds?: Embed[] }
}

let repos: Repositories
let handle: DatabaseHandle
let storefront: RepoRow
let calls: Call[]
let mails: { config: ResolvedEmail; message: MailMessage }[]
let pending: Promise<void>[]
let notifier: Notifier
let unsubscribe: () => void
let counter = 0

const fakeFetch = ((url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body as string) as Call['body'] })
  return Promise.resolve(new Response(null, { status: 204 }))
}) as typeof fetch

/** A notifier over the shared repositories; a second one stands for a restarted server. */
function startNotifier(): Notifier {
  unsubscribe?.()
  const created = createNotifier({
    repositories: repos,
    secretBox: createSecretBox(TEST_SECRET),
    fetch: fakeFetch,
    mailSender: (config, message) => {
      mails.push({ config, message })
      return Promise.resolve()
    },
    now: () => T0,
    sleep: () => Promise.resolve(),
  })
  unsubscribe = repos.fixRuns.onChanged((run) => {
    pending.push(created.handleFixRunChanged(run))
  })
  return created
}

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  calls = []
  mails = []
  pending = []
  storefront = repos.repos.upsert({
    owner: 'kestrel-co',
    name: 'storefront',
    defaultBranch: 'main',
  })
  notifier = startNotifier()
  notifier.channels.add({ kind: 'discord', name: 'ops', url: DISCORD_URL })
})
afterEach(() => {
  unsubscribe()
  handle.close()
})

function newRun(fields: Partial<CreateFixRunInput> = {}) {
  counter += 1
  return repos.fixRuns.create(
    {
      repoId: storefront.id,
      plan: { fixPlanId: null, scanRunId: 7, version: 2 },
      runner: 'github_actions',
      kind: 'fix',
      correlationId: `corr-${counter}`,
      checksMode: 'full',
      ...fields,
    },
    T0,
  ).run
}

function apply(runId: number, ...events: FixRunEvent[]) {
  for (const event of events) repos.fixRuns.applyEvent(runId, event, T0)
}

const toRunning: FixRunEvent[] = [
  { type: 'dispatch_accepted', githubRunId: 9001, githubRunAttempt: 1 },
  { type: 'run_started' },
  { type: 'run_completed', conclusion: 'success', headSha: 'c0ffee1' },
]
const opened = (draft: boolean): FixRunEvent => ({
  type: 'pr_opened',
  number: 42,
  url: PR_URL,
  draft,
})

async function settle() {
  await Promise.all(pending)
  pending = []
}

const verification = (fields: Partial<FixRunVerification> = {}): FixRunVerification => ({
  after: 'deploy',
  status: 'done',
  scan: { kind: 'repo', scanRunId: null, at: T0.toISOString() },
  targeted: [1, 2, 3, 4],
  cleared: [1, 2, 3],
  stillOpen: [4],
  new: [9],
  attempts: 0,
  lastError: null,
  nextAttemptAt: null,
  ...fields,
})

function titles(): string[] {
  return calls.flatMap((c) => (c.body.embeds ?? []).map((e) => e.title))
}

function embedAt(index: number): Embed {
  return calls[index]!.body.embeds![0]!
}

function field(embed: Embed, name: string): string | undefined {
  return embed.fields.find((f) => f.name === name)?.value
}

describe('fix run notifications: events', () => {
  it('announces a draft PR with why it is a draft, from the runner result', async () => {
    const run = newRun()
    apply(run.id, ...toRunning)
    repos.fixRuns.setResult(run.id, {
      install: { status: 'ok' },
      steps: [
        { id: 'a', status: 'applied', reason: null, detail: null, files: [] },
        { id: 'b', status: 'applied', reason: null, detail: null, files: [] },
        { id: 'c', status: 'skipped', reason: 'too_new', detail: null, files: [] },
      ],
      checks: [{ name: 'test', command: 'pnpm test', status: 'failed' }],
    } as never)
    apply(run.id, opened(true))
    await settle()
    expect(titles()).toEqual(['Hinomi: draft fix PR opened for kestrel-co/storefront'])
    const embed = embedAt(0)
    expect(embed.url).toBe(PR_URL)
    expect(field(embed, 'Draft because')).toBe('a check failed in the runner')
    expect(field(embed, 'Pull request')).toBe('#42 (draft)')
    expect(field(embed, 'Plan')).toBe('scan 7, version 2, 2 applied, 1 skipped, 0 failed')
    expect(calls[0]!.body.allowed_mentions).toEqual({ parse: [] })
  })

  it('announces checks failing on its own once the PR was announced', async () => {
    const run = newRun()
    apply(run.id, ...toRunning, opened(false))
    await settle()
    apply(run.id, { type: 'checks_updated', status: 'failing' })
    await settle()
    expect(titles()).toEqual([
      'Hinomi: fix PR opened for kestrel-co/storefront',
      'Hinomi: checks are failing on the fix PR for kestrel-co/storefront',
    ])
    // Checks that fail, pass and fail again are the same story: once per run.
    apply(
      run.id,
      { type: 'checks_updated', status: 'passing' },
      { type: 'checks_updated', status: 'failing' },
    )
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('does not announce intermediate states', async () => {
    const run = newRun()
    apply(run.id, ...toRunning)
    await settle()
    expect(calls).toHaveLength(0)
  })

  it('does not announce a PR that was already merged when first seen', async () => {
    const run = newRun()
    apply(run.id, { type: 'dispatch_accepted', githubRunId: 1 }, { type: 'run_started' })
    apply(run.id, { type: 'run_completed', conclusion: 'success', headSha: 'c0ffee1' })
    apply(run.id, opened(false), { type: 'pr_merged', mergeSha: 'abc1234' })
    await settle()
    expect(titles()).toEqual(['Hinomi: fix PR opened for kestrel-co/storefront'])
    const late = newRun()
    // Linked straight to a merged PR: the PR event is skipped, so is the announcement.
    repos.fixRuns.applyEvent(late.id, { type: 'dispatch_accepted', githubRunId: 2 }, T0)
    repos.fixRuns.applyEvent(late.id, { type: 'pr_merged', mergeSha: 'abc1234' }, T0)
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('announces verified with the cleared count and not cleared with all counts', async () => {
    const verified = newRun()
    apply(verified.id, ...toRunning, opened(false), { type: 'pr_merged', mergeSha: 'abc1234' })
    repos.fixRuns.saveVerify(
      verified.id,
      { verification: verification() },
      {
        type: 'rescan_result',
        cleared: true,
        remaining: 0,
      },
    )
    const partial = newRun({ kind: 'majors' })
    apply(partial.id, ...toRunning, opened(false), { type: 'pr_merged', mergeSha: 'abc1234' })
    repos.fixRuns.saveVerify(
      partial.id,
      { verification: verification() },
      {
        type: 'rescan_result',
        cleared: false,
        remaining: 1,
      },
    )
    await settle()
    const all = titles()
    expect(all).toContain('Hinomi: fix verified for kestrel-co/storefront, 3 findings cleared')
    expect(all).toContain('Hinomi: the fix did not clear every finding for kestrel-co/storefront')
    const notCleared = calls.find((c) => c.body.embeds?.[0]?.title.includes('did not clear'))!
    expect(field(notCleared.body.embeds![0]!, 'Findings')).toBe(
      '4 targeted, 3 cleared, 1 still open, 1 new',
    )
  })

  it('announces failed and lost runs with the reason', async () => {
    const failedRun = newRun()
    apply(failedRun.id, { type: 'failed', reason: 'no caller workflow on the default branch' })
    const lostRun = newRun({ kind: 'majors' })
    apply(
      lostRun.id,
      { type: 'dispatch_accepted', githubRunId: 5 },
      { type: 'lost', reason: 'the workflow run never finished' },
    )
    await settle()
    expect(titles().sort()).toEqual([
      'Hinomi: fix run failed for kestrel-co/storefront',
      'Hinomi: fix run lost for kestrel-co/storefront',
    ])
    expect(field(embedAt(0), 'Reason')).toBe('no caller workflow on the default branch')
  })

  it('does not announce cancelled or superseded runs', async () => {
    const first = newRun()
    apply(first.id, { type: 'dispatch_accepted', githubRunId: 1 })
    newRun() // supersedes the first
    await settle()
    expect(calls).toHaveLength(0)
  })

  it('announces each warning code once per run', async () => {
    const run = newRun()
    apply(run.id, ...toRunning, opened(false), { type: 'pr_merged', mergeSha: 'abc1234' })
    await settle()
    calls = []
    const warning = (
      code: 'watch_paths_skip' | 'deploy_not_seen',
      deploymentId: number | null,
    ) => ({
      code,
      deploymentId,
      message: `${code} for app ${deploymentId}`,
      at: T0.toISOString(),
    })
    repos.fixRuns.saveVerify(run.id, { warnings: [warning('watch_paths_skip', 1)] })
    await settle()
    expect(titles()).toEqual(['Hinomi: the merged fix for kestrel-co/storefront needs a look'])
    expect(field(embedAt(0), 'Warning')).toBe('watch_paths_skip for app 1')
    repos.fixRuns.saveVerify(run.id, {
      warnings: [warning('watch_paths_skip', 1), warning('deploy_not_seen', null)],
    })
    await settle()
    expect(calls).toHaveLength(2)
    expect(field(embedAt(1), 'Warning')).toBe('deploy_not_seen for app null')
    repos.fixRuns.saveVerify(run.id, {
      warnings: [warning('watch_paths_skip', 2), warning('deploy_not_seen', null)],
    })
    await settle()
    expect(calls).toHaveLength(2)
  })
})

describe('fix run notifications: dedup and settings', () => {
  it('sends nothing when the event changed nothing', async () => {
    const run = newRun()
    apply(run.id, ...toRunning, opened(false))
    await settle()
    expect(calls).toHaveLength(1)
    // The same event again changes nothing, so the listener is never called.
    expect(repos.fixRuns.applyEvent(run.id, opened(false), T0)).toMatchObject({ changed: false })
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('does not repeat an event after a restart', async () => {
    const run = newRun()
    apply(run.id, ...toRunning, opened(false), { type: 'pr_merged', mergeSha: 'abc1234' })
    repos.fixRuns.saveVerify(
      run.id,
      { verification: verification() },
      {
        type: 'rescan_result',
        cleared: true,
        remaining: 0,
      },
    )
    await settle()
    const sent = calls.length
    expect(sent).toBeGreaterThan(0)

    notifier = startNotifier()
    // Any later change of the run (here a verification update) must not repeat what went out.
    repos.fixRuns.saveVerify(run.id, { verification: verification({ attempts: 1 }) })
    await settle()
    expect(calls).toHaveLength(sent)
  })

  it('tries a channel again on the next change, as one message when two events are open', async () => {
    const run = newRun()
    const failing = ((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body as string) as Call['body'] })
      return Promise.resolve(new Response('no', { status: 400 }))
    }) as typeof fetch
    unsubscribe()
    notifier = createNotifier({
      repositories: repos,
      secretBox: createSecretBox(TEST_SECRET),
      fetch: failing,
      sleep: () => Promise.resolve(),
    })
    unsubscribe = repos.fixRuns.onChanged((r) => {
      pending.push(notifier.handleFixRunChanged(r))
    })
    apply(run.id, ...toRunning, opened(true))
    await settle()
    expect(calls).toHaveLength(1)
    notifier = startNotifier()
    apply(run.id, { type: 'checks_updated', status: 'failing' })
    await settle()
    expect(calls).toHaveLength(2)
    expect(titles().at(-1)).toBe('Hinomi: draft fix PR opened for kestrel-co/storefront')
    expect(field(embedAt(1), 'Draft because')).toBe('the checks are failing')
    // Both events are recorded: the failing checks do not come as a second message.
    repos.fixRuns.saveVerify(run.id, { warnings: [] })
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('defaults every event on and skips an event that is switched off without recording it', async () => {
    expect(readFixRunEvents(repos.settings)).toEqual(DEFAULT_FIX_RUN_NOTIFY_EVENTS)
    writeFixRunEvents(repos.settings, { failed: false })
    expect(readFixRunEvents(repos.settings)).toEqual({
      ...DEFAULT_FIX_RUN_NOTIFY_EVENTS,
      failed: false,
    })
    const run = newRun()
    apply(run.id, { type: 'failed', reason: 'boom' })
    await settle()
    expect(calls).toHaveLength(0)
    expect(repos.settings.all()['notify.fixRunState']).toBeUndefined()
  })

  it('sends nothing without an enabled channel', async () => {
    const [channel] = notifier.channels.list()
    notifier.channels.update(channel!.id, { enabled: false })
    const run = newRun()
    apply(run.id, { type: 'failed', reason: 'boom' })
    await settle()
    expect(calls).toHaveLength(0)
  })
})

describe('fix run notifications: links and channel formats', () => {
  it('links to Hinomi only on private repos with a public base URL', async () => {
    writePublicBaseUrl(repos.settings, BASE_URL)
    const publicRun = newRun({ checksMode: 'full' })
    apply(publicRun.id, ...toRunning, opened(false))
    const privateRun = newRun({ checksMode: 'install', kind: 'majors' })
    apply(privateRun.id, ...toRunning, opened(false))
    await settle()
    expect(JSON.stringify(calls[0]!.body)).not.toContain(BASE_URL)
    expect(field(embedAt(0), 'In Hinomi')).toBeUndefined()
    expect(field(embedAt(1), 'In Hinomi')).toBe(`${BASE_URL}/fix-runs?sel=${privateRun.id}`)
    // The PR on GitHub is always the main link.
    expect(embedAt(0).url).toBe(PR_URL)
    expect(embedAt(1).url).toBe(PR_URL)
  })

  it('has no Hinomi link on a private repo without a public base URL, and links the run on failures', async () => {
    const run = newRun({ checksMode: 'install' })
    apply(run.id, { type: 'failed', reason: 'boom' })
    await settle()
    expect(JSON.stringify(calls[0]!.body)).not.toContain('fix-runs?sel')
    writePublicBaseUrl(repos.settings, BASE_URL)
    const second = newRun({ checksMode: 'install', kind: 'majors' })
    apply(second.id, { type: 'failed', reason: 'boom' })
    await settle()
    expect(embedAt(1).url).toBe(`${BASE_URL}/fix-runs?sel=${second.id}`)
  })

  it('posts the versioned payload to a generic webhook', async () => {
    notifier.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const run = newRun({ checksMode: 'install' })
    writePublicBaseUrl(repos.settings, BASE_URL)
    apply(run.id, ...toRunning, opened(true))
    await settle()
    const hook = calls.find((c) => c.url === HOOK_URL)!
    expect(hook.body).toMatchObject({
      schema: 'hinomi.fix-run.v1',
      event: 'pr_opened',
      sentAt: T0.toISOString(),
      summary: 'Hinomi: draft fix PR opened for kestrel-co/storefront',
      repo: 'kestrel-co/storefront',
      runId: run.id,
      runKind: 'fix',
      state: 'pr_open',
      plan: { scanRunId: 7, version: 2, steps: null },
      pr: { number: 42, url: PR_URL, draft: true },
      reason: null,
      counts: null,
      warnings: [],
      hinomiUrl: `${BASE_URL}/fix-runs?sel=${run.id}`,
    })
    // No channel URL or token ever reaches a message body.
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('SECRET')
  })

  it('sends an email with the subject, escaped text and the PR link', async () => {
    const channel = notifier.channels.add({
      kind: 'email',
      name: 'mail',
      email: {
        host: 'smtp.example.dev',
        port: 587,
        security: 'starttls',
        from: 'hinomi@example.dev',
        to: ['ops@example.dev'],
        password: 'SECRETPASSWORD',
      },
    })
    expect(channel.kind).toBe('email')
    const run = newRun()
    apply(run.id, { type: 'failed', reason: 'bad <b>reason</b> & more' })
    await settle()
    expect(mails).toHaveLength(1)
    const { message } = mails[0]!
    expect(message.subject).toBe('Hinomi: fix run failed for kestrel-co/storefront')
    expect(message.text).toContain('Repository: kestrel-co/storefront')
    expect(message.text).toContain('Reason: bad <b>reason</b> & more')
    expect(message.html).toContain('bad &lt;b&gt;reason&lt;/b&gt; &amp; more')
    expect(message.html).not.toContain('<b>reason</b>')
    expect(message.text + message.html).not.toContain('SECRET')
  })
})
