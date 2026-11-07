import type { SourceTestResult } from '@hinomi/shared'
import { vi } from 'vitest'
import { createApp } from '../app.js'
import { createSecretBox } from '../crypto/secret-box.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Logger } from '../log.js'
import { createNotifier, SmtpError, type MailMessage, type ResolvedEmail } from '../notify/index.js'
import type { Repositories } from '../repository/index.js'
import type { FindingChange, RunScanOptions, ScanSources, ScanSummary } from '../scan/index.js'
import { createScheduler } from '../scheduler/index.js'
import type { ApiOptions } from './index.js'
import { currentTime } from '@hinomi/shared'

// Test helpers for the API and scheduler. Every name and domain is fictional.

export const EMPTY_SOURCES: ScanSources = {
  coolify: [],
  github: null,
  osv: null,
  fetchLockfiles: () => Promise.resolve([]),
  settings: { osvEnabled: true, includeAccountRepos: false },
}

/**
 * A runScan stand-in that records a run like the real one (row written
 * before the first await) and finishes only when `finish()` is called.
 */
export function controllableScan() {
  const pending: { release: () => void }[] = []
  const calls: RunScanOptions[] = []
  /** Changes the next finished scan reports. */
  const state = { nextChanges: [] as FindingChange[] }
  const runScan = vi.fn(
    (
      storage: { repositories: Repositories },
      _sources: ScanSources,
      options: RunScanOptions,
    ): Promise<ScanSummary> => {
      calls.push(options)
      const clock = options.now ?? (() => currentTime())
      const startedAt = clock()
      const run = storage.repositories.scanRuns.start(options.trigger ?? 'manual', startedAt)
      options.onProgress?.({ phase: 'alerts', done: 0, total: 2, skipped: ['lockfiles'] })
      return new Promise<ScanSummary>((resolve) => {
        pending.push({
          release: () => {
            const changes = state.nextChanges
            state.nextChanges = []
            const finishedAt = clock()
            storage.repositories.scanRuns.finish(
              run.id,
              { status: 'succeeded', sourceResults: {}, findingsOpened: 1 },
              finishedAt,
            )
            resolve({
              scanRunId: run.id,
              status: 'succeeded',
              startedAt,
              finishedAt,
              sourceResults: {},
              findingsOpened: 1,
              findingsFixed: 0,
              changes,
              errors: [],
            })
          },
        })
      })
    },
  )
  return {
    runScan,
    calls,
    set nextChanges(changes: FindingChange[]) {
      state.nextChanges = changes
    },
    /** Finishes the oldest scan still running. */
    finish() {
      pending.shift()?.release()
    },
  }
}

export function recordingLogger() {
  const lines: { level: string; message: string; data?: Record<string, unknown> }[] = []
  const log: Logger = {
    info: (message, data) => lines.push({ level: 'info', message, ...(data && { data }) }),
    warn: (message, data) => lines.push({ level: 'warn', message, ...(data && { data }) }),
    error: (message, data) => lines.push({ level: 'error', message, ...(data && { data }) }),
  }
  return { log, lines, text: () => JSON.stringify(lines) }
}

/** A full app on a fresh in-memory database, with a scheduler whose scans the test controls. */
export function createTestApi({
  withSecret = true,
  sourceFetch,
  fixRunTracking,
}: {
  withSecret?: boolean
  sourceFetch?: typeof fetch
  fixRunTracking?: ApiOptions['fixRunTracking']
} = {}) {
  const { handle, repos } = createTestRepositories({ withSecret })
  const scan = controllableScan()
  const logger = recordingLogger()
  const scheduler = createScheduler({
    repositories: repos,
    log: logger.log,
    buildSources: () => EMPTY_SOURCES,
    runScan: scan.runScan,
    // Timers never fire on their own in route tests.
    setTimer: () => null,
    clearTimer: () => {},
  })
  const testers = {
    coolify: vi.fn((): Promise<SourceTestResult> =>
      Promise.resolve({ ok: true, message: 'Connected' }),
    ),
    github: vi.fn((): Promise<SourceTestResult> =>
      Promise.resolve({ ok: true, message: 'Connected as kestrel-bot', login: 'kestrel-bot' }),
    ),
    githubApp: vi.fn((): Promise<SourceTestResult> =>
      Promise.resolve({
        ok: true,
        message: 'Connected to kestrel-co with 3 selected repos',
        login: 'kestrel-co',
        account: 'kestrel-co',
        repositorySelection: 'selected',
        repoCount: 3,
        missingPermissions: [],
      }),
    ),
  }
  // Webhook deliveries are recorded, never sent.
  const deliveries: { url: string; body: string }[] = []
  const deliveryStatus = { code: 204 }
  // Emails are recorded, never sent. Set `mailFailure.message` to make the next sends fail.
  const mails: { config: ResolvedEmail; message: MailMessage }[] = []
  const mailFailure: { message: string | null } = { message: null }
  const notifier = createNotifier({
    repositories: repos,
    secretBox: withSecret ? createSecretBox(TEST_SECRET) : null,
    log: logger.log,
    sleep: () => Promise.resolve(),
    delivery: { maxAttempts: 1 },
    mailSender: (config, message) => {
      if (mailFailure.message !== null)
        return Promise.reject(new SmtpError(mailFailure.message, 535))
      mails.push({ config, message })
      return Promise.resolve()
    },
    fetch: ((url: string | URL, init?: RequestInit) => {
      deliveries.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
      return Promise.resolve(new Response(null, { status: deliveryStatus.code }))
    }) as typeof fetch,
  })
  const onDigestHourChanged = vi.fn()
  const app = createApp({
    api: {
      repositories: repos,
      scheduler,
      testers,
      log: logger.log,
      notifications: { notifier, onDigestHourChanged },
      ...(sourceFetch && { sourceFetch }),
      ...(fixRunTracking && { fixRunTracking }),
    },
  })

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await app.request(`/api${path}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: text ? (JSON.parse(text) as unknown) : undefined }
  }

  return {
    app,
    repos,
    handle,
    scheduler,
    scan,
    testers,
    logger,
    call,
    notifier,
    deliveries,
    mails,
    mailFailure,
    deliveryStatus,
    onDigestHourChanged,
  }
}

/** A deployed public app running a repo with one critical runtime advisory and one blind spot. */
export function seedWorld(repos: Repositories) {
  const coolify = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  })
  const repo = repos.repos.upsert({
    owner: 'kestrel-co',
    name: 'storefront',
    defaultBranch: 'main',
    alertsEnabled: true,
  })
  const other = repos.repos.upsert({ owner: 'kestrel-co', name: 'docs', alertsEnabled: false })
  const now = currentTime()
  const web = repos.deployments.upsert(
    {
      sourceId: coolify.id,
      externalId: 'app-1',
      kind: 'application',
      name: 'storefront-web',
      domains: ['https://shop.example.dev'],
      reach: 'public',
      server: 'edge-1',
      status: 'running:healthy',
      gitRepository: 'kestrel-co/storefront',
      gitBranch: 'main',
      repoId: repo.id,
    },
    now,
  )
  const proxy = repos.deployments.upsert(
    {
      sourceId: coolify.id,
      externalId: 'svc-2',
      kind: 'service',
      name: 'image-proxy',
      domains: [],
      reach: 'internal',
      server: 'edge-1',
      status: 'running',
    },
    now,
  )
  const advisory = repos.advisories.upsert({
    advisoryKey: 'GHSA-aaaa-bbbb-cccc',
    ghsaId: 'GHSA-aaaa-bbbb-cccc',
    cveIds: ['CVE-2026-0001'],
    ecosystem: 'npm',
    packageName: 'left-pad-ng',
    severity: 'critical',
    cvssScore: 9.8,
    summary: 'Prototype pollution in left-pad-ng',
    vulnerableRanges: ['< 2.0.1'],
    firstPatchedVersion: '2.0.1',
  })
  const low = repos.advisories.upsert({
    advisoryKey: 'GHSA-dddd-eeee-ffff',
    ghsaId: 'GHSA-dddd-eeee-ffff',
    ecosystem: 'npm',
    packageName: 'tiny-glob',
    severity: 'low',
  })
  const critical = repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: advisory.id,
      repoId: repo.id,
      scope: 'runtime',
      reportedBy: ['github', 'osv'],
      manifestPaths: ['package-lock.json'],
      installedVersion: '2.0.0',
    },
    now,
  ).finding
  const lowDev = repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: low.id,
      repoId: repo.id,
      scope: 'dev',
      reportedBy: ['github'],
    },
    now,
  ).finding
  const undeployed = repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: advisory.id,
      repoId: other.id,
      scope: 'runtime',
      reportedBy: ['osv'],
    },
    now,
  ).finding
  const blind = repos.findings.observe(
    { kind: 'blind_spot', blindSpotType: 'no_repo_mapping', deploymentId: proxy.id },
    now,
  ).finding
  return { coolify, repo, other, web, proxy, advisory, critical, lowDev, undeployed, blind }
}

/**
 * A fictional org for fix grouping: a public storefront, an internal ledger API and a repo
 * nothing deploys. `kestrel-http` needs different versions in each repo (mixed targets),
 * `pad-ng` has no patch yet, and several findings are left out of every fix: snoozed,
 * accepted, dismissed upstream, fixed, patched in the lockfile, a blind spot and a coverage note.
 */
export function seedFixWorld(repos: Repositories) {
  const now = currentTime()
  const source = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  })
  const storefront = repos.repos.upsert({ owner: 'kestrel-co', name: 'storefront' })
  const ledger = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger' })
  const docs = repos.repos.upsert({ owner: 'kestrel-co', name: 'docs' })
  const web = repos.deployments.upsert(
    {
      sourceId: source.id,
      externalId: 'app-web',
      kind: 'application',
      name: 'storefront-web',
      domains: ['https://shop.example.dev'],
      reach: 'public',
      status: 'running:healthy',
      repoId: storefront.id,
    },
    now,
  )
  const api = repos.deployments.upsert(
    {
      sourceId: source.id,
      externalId: 'app-api',
      kind: 'application',
      name: 'ledger-api',
      domains: [],
      reach: 'internal',
      status: 'running:healthy',
      repoId: ledger.id,
    },
    now,
  )
  const imageOnly = repos.deployments.upsert(
    {
      sourceId: source.id,
      externalId: 'svc-cache',
      kind: 'service',
      name: 'cache',
      domains: [],
      reach: 'internal',
      status: 'running',
    },
    now,
  )

  const advisory = (
    packageName: string,
    key: string,
    severity: 'critical' | 'high' | 'moderate' | 'low',
    firstPatchedVersion: string | null,
    ecosystem = 'npm',
  ) =>
    repos.advisories.upsert({
      advisoryKey: `GHSA-${key}`,
      ecosystem,
      packageName,
      severity,
      firstPatchedVersion,
    })
  const open = (
    advisoryId: number,
    repoId: number,
    scope: 'runtime' | 'dev' = 'runtime',
    patchedInLockfile = false,
  ) =>
    repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId,
        repoId,
        scope,
        reportedBy: ['github'],
        ...(patchedInLockfile && { patchedInLockfile }),
      },
      now,
    ).finding

  const httpCritical = advisory('kestrel-http', 'http1-aaaa-0001', 'critical', '2.0.1')
  const httpHigh = advisory('kestrel-http', 'http2-aaaa-0002', 'high', '2.1.0')
  const httpModerate = advisory('kestrel-http', 'http3-aaaa-0003', 'moderate', '2.0.4')
  const globOld = advisory('tiny-glob', 'glob1-aaaa-0004', 'low', '1.4.0')
  const globNew = advisory('tiny-glob', 'glob2-aaaa-0005', 'moderate', '1.10.0')
  const padNg = advisory('pad-ng', 'pad1-aaaa-0006', 'critical', null)
  const hyperOpen = advisory('hyper-lite', 'hyp1-aaaa-0007', 'high', '0.14.9', 'cargo')
  const hyperStale = advisory('hyper-lite', 'hyp2-aaaa-0008', 'critical', '0.14.10', 'cargo')
  const xmlSnoozed = advisory('xml-lite', 'xml1-aaaa-0009', 'high', '3.2.0')
  const xmlAccepted = advisory('xml-lite', 'xml2-aaaa-0010', 'high', '3.3.0')
  const xmlDismissed = advisory('xml-lite', 'xml3-aaaa-0011', 'high', '3.4.0')
  const xmlFixed = advisory('xml-lite', 'xml4-aaaa-0012', 'high', '3.5.0')

  const findings = {
    httpCriticalStorefront: open(httpCritical.id, storefront.id),
    httpHighStorefront: open(httpHigh.id, storefront.id),
    httpModerateStorefront: open(httpModerate.id, storefront.id),
    httpCriticalLedger: open(httpCritical.id, ledger.id),
    httpModerateDocs: open(httpModerate.id, docs.id),
    globOldStorefront: open(globOld.id, storefront.id, 'dev'),
    globNewStorefront: open(globNew.id, storefront.id),
    padStorefront: open(padNg.id, storefront.id),
    hyperLedger: open(hyperOpen.id, ledger.id),
    hyperStaleLedger: open(hyperStale.id, ledger.id, 'runtime', true),
    xmlSnoozed: open(xmlSnoozed.id, storefront.id),
    xmlAccepted: open(xmlAccepted.id, storefront.id),
    xmlDismissed: open(xmlDismissed.id, storefront.id),
    xmlFixed: open(xmlFixed.id, storefront.id),
  }
  const decide = (state: 'snoozed' | 'accepted' | 'dismissed_upstream' | 'fixed', id: number) =>
    repos.findings.changeState(id, { state, actor: state === 'fixed' ? 'system' : 'user' }, now)
  decide('snoozed', findings.xmlSnoozed.id)
  decide('accepted', findings.xmlAccepted.id)
  decide('dismissed_upstream', findings.xmlDismissed.id)
  decide('fixed', findings.xmlFixed.id)
  const blind = repos.findings.observe(
    { kind: 'blind_spot', blindSpotType: 'lockfile_missing', repoId: docs.id },
    now,
  ).finding
  const coverage = repos.findings.observe(
    { kind: 'coverage_note', coverageNoteType: 'image_only', deploymentId: imageOnly.id },
    now,
  ).finding
  return { storefront, ledger, docs, web, api, imageOnly, findings, blind, coverage }
}
