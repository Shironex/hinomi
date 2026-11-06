import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import type { FindingChange, ScanSummary } from '../scan/index.js'
import { markDismissedUpstream, markFixed, reopenIfFixed } from '../scan/state.js'
import { maskWebhookUrl } from './channels.js'
import { createNotifier } from './notifier.js'
import { msUntilNextDigest } from './schedule.js'
import { writePublicBaseUrl } from './settings.js'

const DISCORD_URL =
  'https://discord.com/api/webhooks/1234567890/SECRETTOKENabcdefghijklmnopqrstuvwxyz0123'
const HOOK_URL = 'https://hooks.example.dev/in/SECRET-PATH-0123456789'

let repos: Repositories
let handle: DatabaseHandle
let clock: Date
interface Body {
  type: string
  summary: string
  content?: string
  allowed_mentions: unknown
  embeds: { title: string; url?: string; fields: { name: string; value: string }[] }[]
  items: { event: string; title: string; findingId: number }[]
}
let calls: { url: string; body: Body }[]
let responses: Response[]
let sleeps: number[]
let logs: string[]

const fakeFetch = ((url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body as string) as Body })
  return Promise.resolve(responses.shift() ?? new Response(null, { status: 204 }))
}) as typeof fetch

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  clock = new Date('2026-11-06T10:00:00Z')
  calls = []
  responses = []
  sleeps = []
  logs = []
})
afterEach(() => handle.close())

function notifier(options: { secret?: boolean } = {}) {
  return createNotifier({
    repositories: repos,
    secretBox: options.secret === false ? null : createSecretBox(TEST_SECRET),
    fetch: fakeFetch,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    log: {
      info: (m) => logs.push(m),
      warn: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
      error: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
    },
  })
}

function advance(minutes: number) {
  clock = new Date(clock.getTime() + minutes * 60_000)
}

function seedDeployedRepo(name = 'harbor-web', reach: 'public' | 'internal' = 'public') {
  const source = repos.sources.create({ kind: 'coolify', name: `coolify-${name}`, token: 't' })
  const repo = repos.repos.upsert({ owner: 'kestrel-co', name })
  repos.deployments.upsert({
    sourceId: source.id,
    externalId: `uuid-${name}`,
    kind: 'application',
    name,
    reach,
    server: 'edge-1',
    repoId: repo.id,
  })
  return repo
}

let advisoryCounter = 0
function seedAdvisoryFinding(
  repoId: number,
  severity: 'critical' | 'high' | 'moderate' | 'low',
  packageName = 'example-lib',
) {
  const n = ++advisoryCounter
  const advisory = repos.advisories.upsert({
    advisoryKey: `GHSA-0000-0000-${n}`,
    ghsaId: `GHSA-0000-0000-${n}`,
    ecosystem: 'npm',
    packageName,
    severity,
    summary: 'Prototype pollution in example-lib',
    firstPatchedVersion: '1.2.4',
  })
  return repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: advisory.id,
      repoId,
      scope: 'runtime',
      reportedBy: ['github'],
      installedVersion: '1.2.3',
    },
    clock,
  ).finding
}

function summary(changes: FindingChange[]): ScanSummary {
  return {
    scanRunId: 1,
    status: 'succeeded',
    startedAt: clock,
    finishedAt: clock,
    sourceResults: {},
    findingsOpened: changes.length,
    findingsFixed: 0,
    changes,
    errors: [],
  }
}

const opened = (findingId: number): FindingChange => ({ findingId, change: 'opened' })

describe('immediate messages', () => {
  it('sends a Discord embed for a new critical finding on a deployed repo', async () => {
    writePublicBaseUrl(repos.settings, 'https://hinomi.example.dev/')
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')

    await n.handleScanFinished(summary([opened(finding.id)]))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DISCORD_URL)
    const message = calls[0]?.body as Body
    expect(message.allowed_mentions).toEqual({ parse: [] })
    const embed = message.embeds[0] as Body['embeds'][number]
    expect(embed.title).toBe('[CRITICAL] example-lib')
    expect(embed.url).toBe(`https://hinomi.example.dev/finding/${finding.id}`)
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]))
    expect(fields).toMatchObject({
      Repository: 'kestrel-co/harbor-web',
      Deployment: 'harbor-web (public)',
      Installed: '1.2.3',
      'Fixed in': '1.2.4',
      Sources: 'github',
    })
  })

  it('also covers high findings and new blind spots, but not moderate or undeployed ones', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const deployed = seedDeployedRepo()
    const high = seedAdvisoryFinding(deployed.id, 'high')
    const moderate = seedAdvisoryFinding(deployed.id, 'moderate')
    const idle = repos.repos.upsert({ owner: 'kestrel-co', name: 'idle-tool' })
    const undeployed = seedAdvisoryFinding(idle.id, 'critical')
    const blind = repos.findings.observe(
      { kind: 'blind_spot', blindSpotType: 'alerts_disabled', repoId: deployed.id },
      clock,
    ).finding

    await n.handleScanFinished(
      summary([high, moderate, undeployed, blind].map((f) => opened(f.id))),
    )

    expect(calls).toHaveLength(1)
    const titles = calls[0]?.body.embeds.map((e) => e.title)
    expect(titles).toEqual(['[HIGH] example-lib', '[CRITICAL] Dependabot alerts are off'])
  })

  it('does not repeat a finding that was already announced', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')

    await n.handleScanFinished(summary([opened(finding.id)]))
    advance(30)
    await n.handleScanFinished(summary([opened(finding.id)]))
    await n.handleScanFinished(summary([{ findingId: finding.id, change: 'reporters_changed' }]))

    expect(calls).toHaveLength(1)
  })

  it('announces again when a fixed finding is reopened', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    await n.handleScanFinished(summary([opened(finding.id)]))

    advance(60)
    markFixed(repos.findings, repos.findings.get(finding.id)!, clock)
    await n.handleScanFinished(summary([{ findingId: finding.id, change: 'fixed' }]))
    expect(calls).toHaveLength(1)

    advance(60)
    reopenIfFixed(repos.findings, repos.findings.get(finding.id)!, clock)
    await n.handleScanFinished(summary([{ findingId: finding.id, change: 'reopened' }]))

    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.embeds[0]?.title).toBe('Reopened: [CRITICAL] example-lib')
    // and only once
    await n.handleScanFinished(summary([{ findingId: finding.id, change: 'reopened' }]))
    expect(calls).toHaveLength(2)
  })

  it('skips disabled channels and respects the minimum severity of each channel', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'off', url: DISCORD_URL, enabled: false })
    n.channels.add({
      kind: 'webhook',
      name: 'critical only',
      url: HOOK_URL,
      minSeverity: 'critical',
    })
    const repo = seedDeployedRepo()
    const high = seedAdvisoryFinding(repo.id, 'high')

    await n.handleScanFinished(summary([opened(high.id)]))
    expect(calls).toHaveLength(0)

    const critical = seedAdvisoryFinding(repo.id, 'critical')
    await n.handleScanFinished(summary([opened(critical.id)]))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(HOOK_URL)
  })

  it('sends a stable JSON payload to a generic webhook', async () => {
    writePublicBaseUrl(repos.settings, 'https://hinomi.example.dev')
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')

    await n.handleScanFinished(summary([opened(finding.id)]))

    expect(calls[0]?.body).toEqual({
      schema: 'hinomi.notification.v1',
      type: 'immediate',
      sentAt: clock.toISOString(),
      summary: 'Hinomi: 1 new item needs attention',
      omitted: 0,
      items: [
        {
          event: 'opened',
          findingId: finding.id,
          kind: 'advisory',
          severity: 'critical',
          title: 'example-lib',
          blindSpotType: null,
          repo: 'kestrel-co/harbor-web',
          package: 'example-lib',
          ecosystem: 'npm',
          advisory: expect.stringMatching(/^GHSA-/) as string,
          cves: [],
          summary: 'Prototype pollution in example-lib',
          installedVersion: '1.2.3',
          fixedIn: '1.2.4',
          deployments: [{ name: 'harbor-web', reach: 'public', server: 'edge-1' }],
          sources: ['github'],
          url: `https://hinomi.example.dev/finding/${finding.id}`,
        },
      ],
    })
  })

  it('leaves a failed announcement for the digest and never throws', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    responses = [new Response(null, { status: 400 })]

    await expect(n.handleScanFinished(summary([opened(finding.id)]))).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)

    advance(23 * 60)
    await n.sendDigest()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.type).toBe('digest')
    expect(calls[1]?.body.items[0]?.findingId).toBe(finding.id)
  })
})

describe('findings dismissed upstream', () => {
  it('are not announced, nor put in the digest, when first seen already dismissed', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    await n.sendDigest()
    advance(10)
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    advance(1)
    markDismissedUpstream(repos.findings, repos.findings.get(finding.id)!, clock, {
      dismissedAt: clock.toISOString(),
      reason: 'tolerable_risk',
      comment: null,
      alertNumbers: [1],
    })

    await n.handleScanFinished(
      summary([opened(finding.id), { findingId: finding.id, change: 'dismissed_upstream' }]),
    )
    advance(10)
    await n.sendDigest()

    expect(calls).toHaveLength(0)
  })
})

describe('daily digest', () => {
  it('sends nothing when nothing changed, then only what is new', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    await n.sendDigest()
    expect(calls).toHaveLength(0)

    advance(60)
    const repo = seedDeployedRepo()
    seedAdvisoryFinding(repo.id, 'moderate', 'minor-lib')
    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.type).toBe('digest')
    expect(calls[0]?.body.items.map((i) => [i.event, i.title])).toEqual([['opened', 'minor-lib']])
    expect(calls[0]?.body.summary).toBe('Hinomi daily digest: 1 change')

    advance(24 * 60)
    await n.sendDigest()
    expect(calls).toHaveLength(1)
  })

  it('leaves out what was announced already but reports its fix', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    await n.handleScanFinished(summary([opened(finding.id)]))
    expect(calls).toHaveLength(1)

    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(1)

    advance(60)
    markFixed(repos.findings, repos.findings.get(finding.id)!, clock)
    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.items.map((i) => i.event)).toEqual(['fixed'])
  })

  it('skips a finding that opened and was fixed inside the same window', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    await n.sendDigest()
    advance(10)
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'low')
    advance(10)
    markFixed(repos.findings, repos.findings.get(finding.id)!, clock)
    advance(10)
    await n.sendDigest()
    expect(calls).toHaveLength(0)
  })

  it('retries the same period when delivery failed', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    await n.sendDigest()
    advance(10)
    seedAdvisoryFinding(seedDeployedRepo().id, 'low')
    advance(10)
    responses = [new Response(null, { status: 403 })]
    await n.sendDigest()
    advance(24 * 60)
    await n.sendDigest()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.items).toHaveLength(1)
  })

  it('splits a Discord digest into messages of ten embeds', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    await n.sendDigest()
    advance(10)
    const repo = seedDeployedRepo()
    for (let i = 0; i < 12; i++) seedAdvisoryFinding(repo.id, 'low', `lib-${i}`)
    advance(10)
    await n.sendDigest()
    expect(calls.map((c) => c.body.embeds.length)).toEqual([10, 2])
    expect(calls[0]?.body.content).toBe('Hinomi daily digest: 12 changes')
    expect(calls[1]?.body.content).toBeUndefined()
    expect(calls[0]?.body.embeds[0]?.title).toBe('New: [LOW] lib-0')
  })
})

describe('Discord rate limits', () => {
  const limited = (retryAfter: number) =>
    new Response(
      JSON.stringify({ message: 'You are being rate limited.', retry_after: retryAfter }),
      {
        status: 429,
        headers: { 'content-type': 'application/json' },
      },
    )

  it('waits for retry_after but never less than the exponential backoff', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    // 0.2 s asked, backoff is 1 s; then 0 asked, backoff 2 s; then 7.5 s asked, backoff 4 s.
    responses = [limited(0.2), limited(0), limited(7.5)]

    await n.handleScanFinished(summary([opened(finding.id)]))

    expect(calls).toHaveLength(4)
    expect(sleeps).toEqual([1000, 2000, 7500])
  })

  it('gives up after the last attempt without recording the finding as sent', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    responses = Array.from({ length: 5 }, () => limited(0))

    await n.handleScanFinished(summary([opened(finding.id)]))

    expect(calls).toHaveLength(5)
    expect(sleeps).toEqual([1000, 2000, 4000, 8000])

    // Not recorded as sent, so a later scan announces it again.
    await n.handleScanFinished(summary([opened(finding.id)]))
    expect(calls).toHaveLength(6)
  })

  it('does not wait out a huge retry_after', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    responses = [limited(3600)]
    await n.handleScanFinished(summary([opened(finding.id)]))
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })
})

describe('webhook URLs are secrets', () => {
  it('masks the URL everywhere it is returned', () => {
    const n = notifier()
    const view = n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    expect(view.url).toBe('https://discord.com/…0123')
    expect(JSON.stringify(n.channels.list())).not.toContain('SECRETTOKEN')
    expect(JSON.stringify(n.channels.get(view.id))).not.toContain('SECRETTOKEN')
    expect(maskWebhookUrl('not a url')).toBe('****')
    expect(maskWebhookUrl('https://x.example.dev/a')).toBe('https://x.example.dev/…')
  })

  it('stores the URL encrypted when a secret key is set', () => {
    const n = notifier()
    const view = n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    expect(view.urlEncrypted).toBe(true)
    expect(JSON.stringify(repos.settings.all())).not.toContain('SECRET-PATH')
    expect(n.channels.resolve()[0]?.url).toBe(HOOK_URL)
  })

  it('falls back to clear text without a key and says so', () => {
    const n = notifier({ secret: false })
    const view = n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    expect(view.urlEncrypted).toBe(false)
    expect(view.url).not.toContain('SECRET-PATH')
    expect(n.channels.resolve()[0]?.url).toBe(HOOK_URL)
  })

  it('skips a channel whose URL can no longer be decrypted', () => {
    notifier().channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const other = createNotifier({
      repositories: repos,
      secretBox: createSecretBox('another-secret-key'),
      fetch: fakeFetch,
    })
    expect(other.channels.resolve()).toEqual([])
    expect(other.channels.list()[0]?.url).toBe('****')
  })

  it('never logs or returns the URL when delivery fails', async () => {
    const n = notifier()
    const channel = n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    const failing = createNotifier({
      repositories: repos,
      secretBox: createSecretBox(TEST_SECRET),
      fetch: () => Promise.reject(new Error(`connect ECONNREFUSED ${HOOK_URL}`)),
      sleep: () => Promise.resolve(),
      log: {
        info: (m) => logs.push(m),
        warn: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
        error: (m) => logs.push(m),
      },
    })

    await failing.handleScanFinished(summary([opened(finding.id)]))
    const result = await failing.sendTest(channel.id)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('[webhook url]')
    expect(result.error).not.toContain('SECRET-PATH')
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain('SECRET-PATH')
  })

  it('rejects URLs that do not fit the channel kind', () => {
    const n = notifier()
    expect(() => n.channels.add({ kind: 'discord', name: 'x', url: HOOK_URL })).toThrow(/Discord/)
    expect(() =>
      n.channels.add({ kind: 'webhook', name: 'x', url: 'ftp://example.dev/x' }),
    ).toThrow(/http/)
    expect(() => n.channels.add({ kind: 'webhook', name: 'x', url: 'nonsense' })).toThrow(
      /valid URL/,
    )
    expect(() => n.channels.add({ kind: 'webhook', name: ' ', url: HOOK_URL })).toThrow(/name/)
  })
})

describe('sendTest and channel management', () => {
  it('sends a sample message, even to a disabled channel', async () => {
    const n = notifier()
    const channel = n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL, enabled: false })
    expect(await n.sendTest(channel.id)).toEqual({ ok: true })
    expect(calls[0]?.body.type).toBe('test')
    await expect(n.sendTest('missing')).rejects.toThrow(/does not exist/)
  })

  it('updates and removes channels and keeps the stored URL on a rename', () => {
    const n = notifier()
    const channel = n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const renamed = n.channels.update(channel.id, { name: 'ops', minSeverity: 'high' })
    expect(renamed).toMatchObject({ name: 'ops', minSeverity: 'high' })
    expect(n.channels.resolve()[0]?.url).toBe(HOOK_URL)
    expect(n.channels.remove(channel.id)).toBe(true)
    expect(n.channels.remove(channel.id)).toBe(false)
    expect(n.channels.list()).toEqual([])
  })
})

describe('msUntilNextDigest', () => {
  it('counts to the next local occurrence of the hour', () => {
    const now = new Date(2026, 10, 6, 7, 30, 0)
    expect(msUntilNextDigest(now, 8)).toBe(30 * 60_000)
    expect(msUntilNextDigest(new Date(2026, 10, 6, 9, 0, 0), 8)).toBe(23 * 60 * 60_000)
  })

  it('is a full day at exactly the hour', () => {
    const now = new Date(2026, 10, 6, 8, 0, 0)
    expect(msUntilNextDigest(now, 8)).toBe(24 * 60 * 60_000)
  })
})
