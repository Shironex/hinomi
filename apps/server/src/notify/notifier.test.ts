import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import type { FindingChange, ScanSummary } from '../scan/index.js'
import { indexDeployments } from '../scan/deployments.js'
import { runGuards } from '../scan/guards/index.js'
import { fakeGuard, noRepoFiles, rootUserEvidence } from '../scan/guards/testing.js'
import { markDismissedUpstream, markFixed, reopenIfFixed } from '../scan/state.js'
import { maskWebhookUrl, type ResolvedEmail } from './channels.js'
import { SmtpError, type MailMessage } from './email.js'
import { findingNotifications } from './history.js'
import { createNotifier } from './notifier.js'
import { msUntilNextDigest } from './schedule.js'
import { writePublicBaseUrl } from './settings.js'
import { readState, writeState } from './state.js'

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
let mails: { config: ResolvedEmail; message: MailMessage }[]
let mailError: SmtpError | null

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
  mails = []
  mailError = null
})
afterEach(() => handle.close())

/**
 * A notifier whose channels count as past their first scan, so a scan
 * announces item by item. `fresh: true` keeps new channels unprimed, for the
 * first scan summary tests.
 */
function notifier(options: { secret?: boolean; fresh?: boolean } = {}) {
  const n = rawNotifier(options)
  if (options.fresh) return n
  const add = n.channels.add.bind(n.channels)
  n.channels.add = (input) => {
    const channel = add(input)
    const state = readState(repos.settings)
    state.primed[channel.id] = 0
    writeState(repos.settings, state)
    return channel
  }
  return n
}

function rawNotifier(options: { secret?: boolean }) {
  return createNotifier({
    repositories: repos,
    secretBox: options.secret === false ? null : createSecretBox(TEST_SECRET),
    fetch: fakeFetch,
    mailSender: (config, message) => {
      if (mailError) return Promise.reject(mailError)
      mails.push({ config, message })
      return Promise.resolve()
    },
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
    // Highest rank first: the alerts-off blind spot ranks like a critical.
    expect(titles).toEqual(['[CRITICAL] Dependabot alerts are off', '[HIGH] example-lib'])
  })

  it('never sends a coverage note, right away or in the digest', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    seedDeployedRepo()
    const deployment = repos.deployments.list()[0]!
    const note = repos.findings.observe(
      { kind: 'coverage_note', coverageNoteType: 'image_only', deploymentId: deployment.id },
      clock,
    ).finding

    await n.handleScanFinished(summary([opened(note.id)]))
    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(0)
  })

  it('never sends a stale alert that the lockfile already patched, right away or in the digest', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const stale = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: stale.advisoryId!,
        repoId: stale.repoId!,
        reportedBy: ['github'],
        patchedInLockfile: true,
      },
      clock,
    )

    await n.handleScanFinished(summary([opened(stale.id)]))
    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(0)
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
          guardCheck: null,
          guardLevel: null,
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

describe('first scan summary and large batches', () => {
  /** Findings on one public app, one per severity given, in creation order. */
  function seedMany(severities: ('critical' | 'high')[]) {
    const repo = repos.repos.getByName('kestrel-co', 'harbor-web') ?? seedDeployedRepo()
    return severities.map((severity, i) => seedAdvisoryFinding(repo.id, severity, `pkg-${i}`))
  }

  const notified = (findingId: number) =>
    findingNotifications(repos.settings, findingId, repos.findings.listEvents(findingId))

  it("sends one summary on a channel's first scan and records every finding", async () => {
    writePublicBaseUrl(repos.settings, 'https://hinomi.example.dev')
    const n = notifier({ fresh: true })
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const findings = seedMany(['high', 'high', 'critical', 'high', 'high', 'high', 'critical'])

    await n.handleScanFinished(summary(findings.map((f) => opened(f.id))))

    expect(calls).toHaveLength(1)
    const message = calls[0]!.body
    expect(message.content).toContain('Hinomi first scan: 7 items need attention')
    expect(message.content).toContain('Exposed on a public app: 7')
    expect(message.content).toContain('By severity: 2 critical, 5 high')
    expect(message.content).toContain('Exposure view: https://hinomi.example.dev/')
    // The top five by rank: the criticals first.
    expect(message.embeds).toHaveLength(5)
    expect(message.embeds.slice(0, 2).map((e) => e.title)).toEqual([
      '[CRITICAL] pkg-2',
      '[CRITICAL] pkg-6',
    ])
    // Every finding counts as announced, so neither the next scan nor the digest repeats it.
    for (const f of findings) expect(notified(f.id)).toHaveLength(1)
    expect(notified(findings[0]!.id)[0]).toMatchObject({ channelName: 'alerts', event: 'opened' })

    // Later scans announce item by item.
    const next = seedAdvisoryFinding(repos.repos.getByName('kestrel-co', 'harbor-web')!.id, 'high')
    await n.handleScanFinished(summary([opened(next.id)]))
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.content).toBe('Hinomi: 1 new item needs attention')
    advance(60 * 24)
    await n.sendDigest()
    expect(calls).toHaveLength(2)
  })

  it('primes a channel on a scan with nothing to announce', async () => {
    const n = notifier({ fresh: true })
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    await n.handleScanFinished(summary([]))
    const [finding] = seedMany(['critical'])
    await n.handleScanFinished(summary([opened(finding!.id)]))
    expect(calls[0]!.body.content).toBe('Hinomi: 1 new item needs attention')
  })

  it('sends a summary instead of a message each above ten items', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const ten = seedMany(Array<'high'>(10).fill('high'))
    await n.handleScanFinished(summary(ten.map((f) => opened(f.id))))
    expect(calls[0]!.body).toMatchObject({ type: 'immediate' })
    expect(calls[0]!.body.items).toHaveLength(10)

    const eleven = seedMany([...Array<'high'>(10).fill('high'), 'critical'])
    await n.handleScanFinished(summary(eleven.map((f) => opened(f.id))))
    expect(calls).toHaveLength(2)
    const body = calls[1]!.body as Body & { counts: unknown; omitted: number; link: unknown }
    expect(body).toMatchObject({
      type: 'summary',
      summary: 'Hinomi: 11 new items need attention',
      omitted: 6,
      link: null,
      counts: {
        total: 11,
        byTier: { exposed: 11 },
        bySeverity: { critical: 1, high: 10, moderate: 0, low: 0 },
      },
    })
    expect(body.items).toHaveLength(5)
    expect(body.items[0]).toMatchObject({ findingId: eleven.at(-1)!.id })
    for (const f of eleven) expect(notified(f.id)).toHaveLength(1)
  })

  it('orders every batch by rank: public criticals before internal ones', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    const internal = seedDeployedRepo('dock-worker', 'internal')
    const exposed = seedDeployedRepo('harbor-web', 'public')
    const a = seedAdvisoryFinding(internal.id, 'critical', 'internal-crit')
    const b = seedAdvisoryFinding(exposed.id, 'high', 'public-high')
    const c = seedAdvisoryFinding(exposed.id, 'critical', 'public-crit')
    await n.handleScanFinished(summary([a, b, c].map((f) => opened(f.id))))
    expect(calls[0]!.body.items.map((i) => i.title)).toEqual([
      'public-crit',
      'public-high',
      'internal-crit',
    ])
  })

  it('records each delivered Discord message before the next one goes out', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const findings = seedMany(Array<'high'>(10).fill('high'))
    // Long summaries push the embeds over Discord's size budget: several messages.
    for (const f of findings) {
      repos.advisories.upsert({
        ...repos.advisories.get(f.advisoryId!)!,
        summary: 'x'.repeat(390),
        cveIds: Array.from({ length: 30 }, (_, i) => `CVE-2026-${1000 + i}`),
      })
    }
    responses = [new Response(null, { status: 204 }), new Response('bad', { status: 400 })]
    await n.handleScanFinished(summary(findings.map((f) => opened(f.id))))
    expect(calls.length).toBe(2)
    const firstBatch = calls[0]!.body.embeds.length
    expect(firstBatch).toBeLessThan(10)
    const recorded = findings.filter((f) => notified(f.id).length > 0)
    expect(recorded).toHaveLength(firstBatch)
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

describe('desktop release findings', () => {
  function seedReleaseFinding(
    repoId: number,
    severity: 'critical' | 'high',
    scope: 'runtime' | 'dev' = 'runtime',
  ) {
    const n = ++advisoryCounter
    const advisory = repos.advisories.upsert({
      advisoryKey: `GHSA-desk-0000-${n}`,
      ghsaId: `GHSA-desk-0000-${n}`,
      ecosystem: 'npm',
      packageName: `example-${severity}-${scope}`,
      severity,
    })
    return repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: advisory.id,
        repoId,
        scope,
        reportedBy: ['osv'],
        releaseTag: 'v2.3.0',
      },
      clock,
    ).finding
  }

  it('sends a critical runtime one right away and leaves the rest to the digest', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    const desk = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-desk' })
    const critical = seedReleaseFinding(desk.id, 'critical')
    const high = seedReleaseFinding(desk.id, 'high')
    const devOnly = seedReleaseFinding(desk.id, 'critical', 'dev')

    await n.handleScanFinished(summary([critical, high, devOnly].map((f) => opened(f.id))))
    expect(calls.map((c) => c.body.embeds.map((e) => e.title))).toEqual([
      ['[CRITICAL] example-critical-runtime'],
    ])

    advance(60)
    await n.sendDigest()
    const digest = calls.slice(1).flatMap((c) => c.body.embeds.map((e) => e.title))
    // The critical runtime one was announced already, so the digest leaves it out.
    expect(digest).toEqual([
      'New: [CRITICAL] example-critical-dev',
      'New: [HIGH] example-high-runtime',
    ])
  })
})

describe('guard findings', () => {
  /** Runs a fake root user check on the deployment, at the given level, through the framework. */
  async function guardScan(level: 'warn' | 'fail' | 'unknown') {
    const fake = fakeGuard('root_user')
    const deployment = repos.deployments.list()[0]!
    fake.state.results = [
      { subject: { deploymentId: deployment.id }, level, evidence: rootUserEvidence() },
    ]
    const index = indexDeployments(repos)
    const ctx = {
      deployments: index.deployments,
      repos: [],
      index,
      scans: new Map(),
      support: null,
      supportWindowDays: 90,
      repoFiles: noRepoFiles(),
      behindReleases: { rust: 4, bun: 4 },
      now: clock,
    }
    return summary(await runGuards(repos, [fake.guard], ctx, { warn: () => {} }))
  }

  const titles = () =>
    calls.flatMap((c) => c.body.items.map((i) => [c.body.type, i.event, i.title]))

  it('sends fail right away, warn in the digest, and unknown never', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    seedDeployedRepo()

    await n.handleScanFinished(await guardScan('unknown'))
    advance(60)
    await n.sendDigest()
    expect(calls).toHaveLength(0)

    advance(60)
    await n.handleScanFinished(await guardScan('warn'))
    expect(calls).toHaveLength(0)
    advance(24 * 60)
    await n.sendDigest()
    expect(titles()).toEqual([['digest', 'escalated', 'Container runs as root']])
    const [item] = calls[0]!.body.items as unknown as { guardCheck: string; guardLevel: string }[]
    expect(item).toMatchObject({ guardCheck: 'root_user', guardLevel: 'warn' })

    advance(60)
    await n.handleScanFinished(await guardScan('fail'))
    expect(titles().at(-1)).toEqual(['immediate', 'escalated', 'Container runs as root'])
    expect(calls).toHaveLength(2)

    // The same level again, and an improvement, send nothing; the digest skips the announced escalation.
    advance(60)
    await n.handleScanFinished(await guardScan('fail'))
    await n.handleScanFinished(await guardScan('warn'))
    advance(24 * 60)
    await n.sendDigest()
    expect(calls).toHaveLength(2)
  })

  it('sends a new fail right away as opened', async () => {
    const n = notifier()
    n.channels.add({ kind: 'discord', name: 'alerts', url: DISCORD_URL })
    seedDeployedRepo()
    await n.handleScanFinished(await guardScan('fail'))
    expect(calls[0]?.body.embeds.map((e) => e.title)).toEqual(['[HIGH] Container runs as root'])
  })

  it('never sends a guard whose check is turned off', async () => {
    const n = notifier()
    n.channels.add({ kind: 'webhook', name: 'hook', url: HOOK_URL })
    seedDeployedRepo()
    const deployment = repos.deployments.list()[0]!
    repos.checkOverrides.create({
      check: 'root_user',
      subject: { deploymentId: deployment.id },
      reason: 'sandboxed on purpose',
    })
    await n.handleScanFinished(await guardScan('fail'))
    advance(24 * 60)
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

const SMTP_PASSWORD = 'smtp-SECRET-pass-0123'
const emailInput = {
  host: 'smtp.example.dev',
  port: 587,
  security: 'starttls' as const,
  user: 'hinomi@example.dev',
  password: SMTP_PASSWORD,
  from: 'hinomi@example.dev',
  to: ['ops@example.dev', 'oncall@example.dev'],
}

describe('email channel', () => {
  it('stores the password encrypted and never shows it', () => {
    const n = notifier()
    const view = n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    expect(JSON.stringify(view)).not.toContain('SECRET')
    expect(view).toMatchObject({
      kind: 'email',
      url: 'smtp.example.dev:587',
      urlEncrypted: true,
      email: { host: 'smtp.example.dev', user: 'hinomi@example.dev', passwordSet: true },
    })
    const stored = JSON.stringify(repos.settings.get('notify.channels', z.unknown()))
    expect(stored).not.toContain(SMTP_PASSWORD)
    expect(n.channels.resolve()[0]?.email?.password).toBe(SMTP_PASSWORD)
  })

  it('falls back to clear text without a key and says so', () => {
    const view = notifier({ secret: false }).channels.add({
      kind: 'email',
      name: 'mail',
      email: emailInput,
    })
    expect(view.urlEncrypted).toBe(false)
    expect(view.email?.passwordSet).toBe(true)
  })

  it('needs no password when there is no user', () => {
    const n = notifier()
    const view = n.channels.add({
      kind: 'email',
      name: 'relay',
      email: {
        host: '10.0.0.5',
        port: 25,
        security: 'none',
        from: 'a@example.dev',
        to: ['b@example.dev'],
      },
    })
    expect(view).toMatchObject({ urlEncrypted: true, email: { user: null, passwordSet: false } })
  })

  it('keeps the password on a patch without one, replaces it, and removes it with an empty one', () => {
    const n = notifier()
    const { id } = n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    const password = () => n.channels.resolve()[0]?.email?.password
    n.channels.update(id, { email: { port: 465, security: 'tls' } })
    expect(n.channels.resolve()[0]?.email).toMatchObject({ port: 465, security: 'tls' })
    expect(password()).toBe(SMTP_PASSWORD)
    n.channels.update(id, { email: { password: 'next-pass' } })
    expect(password()).toBe('next-pass')
    n.channels.update(id, { email: { password: '' } })
    expect(password()).toBeNull()
  })

  it('rejects the wrong shape for the kind', () => {
    const n = notifier()
    expect(() => n.channels.add({ kind: 'email', name: 'x', url: HOOK_URL })).toThrow(/SMTP/)
    expect(() => n.channels.add({ kind: 'webhook', name: 'x', email: emailInput })).toThrow(
      /URL is required/,
    )
    const { id } = n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    expect(() => n.channels.update(id, { url: HOOK_URL })).toThrow(/no URL/)
  })

  it('skips a channel whose password can no longer be decrypted', () => {
    const n = notifier()
    n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    const other = createNotifier({ repositories: repos, secretBox: null })
    expect(other.channels.resolve()).toHaveLength(0)
    expect(other.channels.list()[0]?.email?.passwordSet).toBe(true)
  })

  it('sends one email with every item of an immediate batch', async () => {
    writePublicBaseUrl(repos.settings, 'https://hinomi.example.dev')
    const n = notifier()
    n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    const repo = seedDeployedRepo()
    const a = seedAdvisoryFinding(repo.id, 'critical')
    const b = seedAdvisoryFinding(repo.id, 'high', 'other-lib')

    await n.handleScanFinished(summary([opened(a.id), opened(b.id)]))

    expect(calls).toHaveLength(0)
    expect(mails).toHaveLength(1)
    const { config, message } = mails[0] as (typeof mails)[number]
    expect(config.host).toBe('smtp.example.dev')
    expect(message.to).toEqual(['ops@example.dev', 'oncall@example.dev'])
    expect(message.subject).toBe('Hinomi: 2 new items need attention')
    expect(message.text).toContain('[CRITICAL] example-lib')
    expect(message.text).toContain(`https://hinomi.example.dev/finding/${a.id}`)
    expect(message.html).toContain('[HIGH] other-lib')

    // Deduped like every channel.
    await n.handleScanFinished(summary([opened(a.id)]))
    expect(mails).toHaveLength(1)
  })

  it('sends the first scan summary as one email with the counts', async () => {
    const n = notifier({ fresh: true })
    n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    const repo = seedDeployedRepo()
    const a = seedAdvisoryFinding(repo.id, 'critical')
    await n.handleScanFinished(summary([opened(a.id)]))
    expect(mails).toHaveLength(1)
    const { message } = mails[0]!
    expect(message.subject).toBe('Hinomi first scan: 1 item needs attention')
    expect(message.text).toContain('Exposed on a public app: 1')
    expect(message.html).toContain('By severity: 1 critical')
  })

  it('leaves a failed email for the digest and never leaks the password', async () => {
    const n = notifier()
    n.channels.add({ kind: 'email', name: 'mail', email: emailInput })
    const finding = seedAdvisoryFinding(seedDeployedRepo().id, 'critical')
    mailError = new SmtpError(
      `Invalid login for ${SMTP_PASSWORD}`.replace(SMTP_PASSWORD, '[password]'),
      535,
    )

    await n.handleScanFinished(summary([opened(finding.id)]))
    expect(mails).toHaveLength(0)
    expect(logs.join('\n')).not.toContain(SMTP_PASSWORD)

    mailError = null
    advance(60)
    await n.sendDigest()
    expect(mails).toHaveLength(1)
    expect(mails[0]?.message.subject).toContain('daily digest')
    expect(mails[0]?.message.text).toContain('New: [CRITICAL] example-lib')
  })

  it('sends a test email, even to a disabled channel, and reports a failure', async () => {
    const n = notifier()
    const { id } = n.channels.add({
      kind: 'email',
      name: 'mail',
      email: emailInput,
      enabled: false,
    })
    expect(await n.sendTest(id)).toEqual({ ok: true })
    expect(mails[0]?.message.subject).toBe('Hinomi test message')
    mailError = new SmtpError('Could not send the email: Invalid login', 535)
    const failed = await n.sendTest(id)
    expect(failed).toEqual({ ok: false, error: 'Could not send the email: Invalid login' })
  })
})
