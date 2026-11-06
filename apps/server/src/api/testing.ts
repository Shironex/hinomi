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
      const clock = options.now ?? (() => new Date())
      const startedAt = clock()
      const run = storage.repositories.scanRuns.start(options.trigger ?? 'manual', startedAt)
      options.onProgress?.({ done: 0, total: 2 })
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
export function createTestApi({ withSecret = true } = {}) {
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
  const now = new Date()
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
