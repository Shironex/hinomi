import {
  SCAN_PHASES,
  type ScanPhase,
  type ScanRunStatus,
  type ScanTrigger,
  type SourceKind,
  currentTime,
} from '@hinomi/shared'
import type { RepoRow, ScanSourceResult } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { mapLimit } from '../sources/osv/index.js'
import { applyRepoAdvisories, coveringSources, type FindingChange } from './apply.js'
import { applyBlindSpots } from './blind-spots.js'
import {
  collectGithub,
  collectOsv,
  collectPins,
  collectRepo,
  errorMessage,
  type RepoScan,
} from './collect.js'
import { repoKey } from './ownership.js'
import { indexDeployments, syncDeployments, type DeploymentIndex } from './deployments.js'
import { readBehindReleases, readSupportWindowDays, type SupportIndex } from '../support/index.js'
import { GUARDS, runGuards, type Guard } from './guards/index.js'
import { createRepoFileReader } from './guards/repo-files.js'
import { runImageScan, type ImageScanResult } from './image-scan.js'
import { saveScanPlans } from './plans.js'
import { scanReleases } from './releases.js'
import type { ScanSources } from './sources.js'
import { expireDeferred } from './state.js'

export interface ScanLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export interface RunScanOptions {
  trigger?: ScanTrigger
  /** Clock for every timestamp the scan writes. Defaults to the system clock. */
  now?: () => Date
  log?: ScanLogger
  /** Repos fetched in parallel. */
  concurrency?: number
  /** Called when a phase starts and after each unit of it. A listener that throws is ignored. */
  onProgress?: (progress: ScanProgress) => void
  /** Guard checks to run in the ranking phase. Defaults to the registered ones (GUARDS). */
  guards?: readonly Guard[]
  /** The support data the support checks read; null (the default) leaves their findings alone. */
  support?: () => SupportIndex | null
}

export interface ScanProgress {
  /** The step the scan is on. */
  phase: ScanPhase
  /** Units done in this phase: Coolify instances and the account repo list, or repos. */
  done: number
  /** Units in this phase; 0 when it has none (ranking). */
  total: number
  /** Phases this scan leaves out, decided when it starts. */
  skipped: ScanPhase[]
}

export interface ScanError {
  source: SourceKind
  /** `owner/name` for a per repo error, the source name for a source wide one. */
  subject: string
  error: string
}

export interface ScanSummary {
  scanRunId: number
  status: Exclude<ScanRunStatus, 'running'>
  startedAt: Date
  finishedAt: Date
  sourceResults: Partial<Record<SourceKind, ScanSourceResult>>
  findingsOpened: number
  findingsFixed: number
  /** Findings created or changed by this scan, in the order it happened. */
  changes: FindingChange[]
  errors: ScanError[]
}

const silent: ScanLogger = { info() {}, warn() {}, error() {} }

/** Per source tally: how many units (instances or repos) it tried and how many failed. */
interface Tally {
  attempted: number
  failed: number
  counts: Record<string, number>
}

type Tallies = Partial<Record<SourceKind, Tally>>

/** Per GitHub source tally, to record each source's own outcome on its row. */
interface SourceTally {
  attempted: number
  failed: number
  first: { subject: string; error: string } | null
}

function tally(tallies: Tallies, source: SourceKind): Tally {
  return (tallies[source] ??= { attempted: 0, failed: 0, counts: {} })
}

function bump(t: Tally, key: string, by = 1): void {
  t.counts[key] = (t.counts[key] ?? 0) + by
}

interface ScanContext {
  repositories: Repositories
  sources: ScanSources
  now: () => Date
  log: ScanLogger
  tallies: Tallies
  /** By GitHub source id. */
  githubTallies: Map<number, SourceTally>
  /** Account repo lists read this scan, by GitHub source id (`owner/name` lowercased). */
  listed: Map<number, Set<string>>
  errors: ScanError[]
  skipped: ScanPhase[]
  progress: (phase: ScanPhase, done: number, total: number) => void
}

/** True when the account repo list is read in the deployments phase. */
function listsAccountRepos(sources: ScanSources): boolean {
  return sources.github.length > 0 && sources.settings.includeAccountRepos
}

/** Phases with nothing to do for these sources. Matching and ranking always run. */
export function skippedPhases(sources: ScanSources): ScanPhase[] {
  const skipped: ScanPhase[] = []
  if (sources.coolify.length === 0 && !listsAccountRepos(sources)) skipped.push('deployments')
  if (sources.github.length === 0) skipped.push('alerts')
  if (!sources.osv) skipped.push('lockfiles')
  return skipped
}

/** Counts units of one phase: reports 0 of total now and one more on each call. */
function startPhase(ctx: ScanContext, phase: ScanPhase, total: number): () => void {
  let done = 0
  ctx.progress(phase, done, total)
  return () => ctx.progress(phase, ++done, total)
}

/** Counts one unit of work of a GitHub source, failed when `error` is given. */
function tallySource(
  ctx: ScanContext,
  sourceId: number,
  failure?: { subject: string; error: string },
): void {
  let t = ctx.githubTallies.get(sourceId)
  if (!t) {
    t = { attempted: 0, failed: 0, first: null }
    ctx.githubTallies.set(sourceId, t)
  }
  t.attempted++
  if (!failure) return
  t.failed++
  t.first ??= failure
}

function recordError(ctx: ScanContext, error: ScanError): void {
  ctx.errors.push(error)
  ctx.log.warn('scan: a source failed', {
    source: error.source,
    subject: error.subject,
    error: error.error,
  })
}

async function syncCoolify(ctx: ScanContext, step: () => void): Promise<void> {
  for (const source of ctx.sources.coolify) {
    const t = tally(ctx.tallies, 'coolify')
    t.attempted++
    try {
      const records = await source.fetchInventory()
      const result = syncDeployments(ctx.repositories, source.sourceId, records, ctx.now())
      bump(t, 'deployments', result.deployments)
      bump(t, 'removed', result.removed)
      ctx.repositories.sources.markOk(source.sourceId, ctx.now())
    } catch (error) {
      t.failed++
      const message = errorMessage(error)
      ctx.repositories.sources.markError(source.sourceId, message, ctx.now())
      recordError(ctx, { source: 'coolify', subject: source.name, error: message })
    }
    step()
  }
}

/**
 * Upserts every repo each GitHub source sees, for the everything-else view, and remembers each
 * list so repos are not asked of sources that do not see them.
 */
async function syncAccountRepos(ctx: ScanContext, step: () => void): Promise<number[]> {
  if (!listsAccountRepos(ctx.sources)) return []
  const ids = new Set<number>()
  for (const github of ctx.sources.github) {
    try {
      const repos = await github.listAccountRepos()
      ctx.listed.set(github.sourceId, new Set(repos.map((r) => repoKey(r.owner, r.name))))
      tallySource(ctx, github.sourceId)
      const upserted = ctx.repositories.db.transaction(() =>
        repos.map(
          (r) =>
            ctx.repositories.repos.upsert({
              owner: r.owner,
              name: r.name,
              archived: r.archived,
              ...(r.defaultBranch && { defaultBranch: r.defaultBranch }),
            }).id,
        ),
      )
      for (const id of upserted) ids.add(id)
    } catch (error) {
      const t = tally(ctx.tallies, 'github')
      t.attempted++
      t.failed++
      const failure = { subject: `${github.name} account repos`, error: errorMessage(error) }
      tallySource(ctx, github.sourceId, failure)
      recordError(ctx, { source: 'github', ...failure })
    }
    step()
  }
  return [...ids]
}

function reposToScan(ctx: ScanContext, index: DeploymentIndex, accountRepoIds: number[]) {
  const ids = new Set([...index.byRepo.keys(), ...accountRepoIds])
  return [...ids]
    .map((id) => ctx.repositories.repos.get(id))
    .filter((r): r is RepoRow => r !== undefined)
}

function tallyRepo(ctx: ScanContext, scan: RepoScan): void {
  const name = `${scan.repo.owner}/${scan.repo.name}`
  for (const probe of scan.probes ?? []) {
    const alerts = scan.alerts
    const alertsError =
      probe.sourceId === scan.sourceId && alerts.status === 'error' ? alerts.error : undefined
    const error = probe.error ?? alertsError
    tallySource(ctx, probe.sourceId, error === undefined ? undefined : { subject: name, error })
  }
  if (ctx.sources.github.length > 0) {
    const t = tally(ctx.tallies, 'github')
    t.attempted++
    bump(t, 'repos')
    const failure =
      scan.health.status === 'error'
        ? scan.health.error
        : scan.alerts.status === 'error'
          ? scan.alerts.error
          : null
    if (failure !== null) {
      t.failed++
      recordError(ctx, { source: 'github', subject: name, error: failure })
    }
    if (scan.alerts.status === 'ok') bump(t, 'alerts', scan.alerts.value.alerts.length)
  }
  if (!ctx.sources.osv) return
  const t = tally(ctx.tallies, 'osv')
  t.attempted++
  bump(t, 'repos')
  if (scan.osv.status === 'error') {
    t.failed++
    recordError(ctx, { source: 'osv', subject: name, error: scan.osv.error })
  } else if (scan.osv.status === 'ok') {
    bump(t, 'lockfiles', scan.osv.value.lockfiles.length)
    bump(t, 'matches', scan.osv.value.matches.length)
  }
}

/** Records which GitHub sources see the repo and which one reads it. */
function saveOwnership(ctx: Pick<ScanContext, 'repositories' | 'now'>, scan: RepoScan): void {
  if (scan.probes === undefined || scan.probes.length === 0) return
  const { repoSources } = ctx.repositories
  const at = ctx.now()
  for (const probe of scan.probes) {
    if (probe.sees === true) {
      repoSources.record(scan.repo.id, probe.sourceId, probe.alertsReadable, at)
    }
  }
  repoSources.forget(
    scan.repo.id,
    scan.probes.filter((p) => p.sees === false).map((p) => p.sourceId),
  )
  repoSources.setOwner(scan.repo.id, scan.sourceId ?? null)
}

function saveRepoHealth(ctx: Pick<ScanContext, 'repositories' | 'now'>, scan: RepoScan): void {
  const { repos } = ctx.repositories
  saveOwnership(ctx, scan)
  if (scan.health.status === 'ok') {
    const health = scan.health.value
    repos.upsert({
      owner: scan.repo.owner,
      name: scan.repo.name,
      archived: health.archived,
      alertsEnabled: health.alertsEnabled,
      ...(health.defaultBranch && { defaultBranch: health.defaultBranch }),
    })
  }
  const anyOk = [scan.health, scan.alerts, scan.osv].some((o) => o.status === 'ok')
  if (anyOk) repos.markScanned(scan.repo.id, ctx.now())
}

/**
 * Runs `fn` over every repo, `concurrency` at a time, as one phase. A skipped
 * phase still runs `fn` (it answers `skipped` at once) but reports nothing.
 */
async function perRepo<T>(
  ctx: ScanContext,
  phase: ScanPhase,
  repos: RepoRow[],
  concurrency: number,
  fn: (repo: RepoRow, index: number) => Promise<T>,
): Promise<T[]> {
  const indexed = repos.map((repo, index) => ({ repo, index }))
  if (ctx.skipped.includes(phase)) return Promise.all(indexed.map((r) => fn(r.repo, r.index)))
  const step = startPhase(ctx, phase, repos.length)
  return mapLimit(indexed, concurrency, async ({ repo, index }) => {
    const result = await fn(repo, index)
    step()
    return result
  })
}

/**
 * Fetches GitHub for every repo, then OSV for every repo (the lockfile ref
 * needs the default branch GitHub reports), then writes each one. One bad
 * repo never stops the others.
 */
async function scanRepos(
  ctx: ScanContext,
  repos: RepoRow[],
  index: DeploymentIndex,
  concurrency: number,
): Promise<{ scans: Map<number, RepoScan>; changes: FindingChange[] }> {
  const deploymentsOf = (repo: RepoRow) => index.byRepo.get(repo.id) ?? []
  const github = await perRepo(ctx, 'alerts', repos, concurrency, (repo) =>
    collectGithub(ctx.sources, repo, ctx.listed),
  )
  // Runtime pins are read in the lockfile phase, after the lockfiles, through the same reader.
  const osv = await perRepo(ctx, 'lockfiles', repos, concurrency, async (repo, i) => {
    const { health, sourceId } = github[i]!
    const lockfiles = await collectOsv(ctx.sources, repo, deploymentsOf(repo), health, sourceId)
    const pins = await collectPins(
      ctx.sources,
      ctx.repositories.runtimePins,
      repo,
      deploymentsOf(repo),
      health,
      sourceId,
      ctx.now(),
    )
    if (pins?.error) {
      ctx.log.warn('scan: runtime pins could not be read, keeping the last good ones', {
        repo: `${repo.owner}/${repo.name}`,
        error: pins.error,
      })
    }
    return { lockfiles, pins }
  })
  const step = startPhase(ctx, 'matching', repos.length)
  const scans = new Map<number, RepoScan>()
  const changes: FindingChange[] = []
  repos.forEach((repo, i) => {
    const scan: RepoScan = {
      repo,
      deployed: deploymentsOf(repo).length > 0,
      ...github[i]!,
      osv: osv[i]!.lockfiles,
      ...(osv[i]!.pins !== undefined && { pins: osv[i]!.pins }),
    }
    tallyRepo(ctx, scan)
    try {
      saveRepoHealth(ctx, scan)
      changes.push(...applyRepoAdvisories(ctx.repositories, scan, ctx.now()))
      scans.set(scan.repo.id, scan)
    } catch (error) {
      recordError(ctx, {
        source: 'github',
        subject: `${scan.repo.owner}/${scan.repo.name}`,
        error: `could not save results: ${errorMessage(error)}`,
      })
    }
    step()
  })
  return { scans, changes }
}

/**
 * The desktop release tier (releases.ts): daily latest release checks and tag scans of the repos
 * nothing deploys. Failures count against the source that failed, like a repo's.
 */
async function checkReleases(
  ctx: ScanContext,
  repos: RepoRow[],
  index: DeploymentIndex,
  scans: Map<number, RepoScan>,
  concurrency: number,
): Promise<FindingChange[]> {
  const result = await scanReleases({
    repositories: ctx.repositories,
    sources: ctx.sources,
    index,
    repos,
    scans,
    now: ctx.now(),
    concurrency,
  })
  if (result.checked > 0) bump(tally(ctx.tallies, 'github'), 'releases', result.checked)
  if (result.scanned > 0) bump(tally(ctx.tallies, 'osv'), 'releaseTags', result.scanned)
  for (const error of result.errors) {
    const t = tally(ctx.tallies, error.source)
    t.attempted++
    t.failed++
    recordError(ctx, error)
  }
  return result.changes
}

/**
 * Records the image scan on the Coolify tally: counts, and an error per instance that failed
 * (a 403 or an outage). An instance without the endpoint is not an error, only a count and a log.
 */
function recordImageScan(ctx: ScanContext, result: ImageScanResult): void {
  if (ctx.sources.settings.imageScan === 'off') return
  const t = tally(ctx.tallies, 'coolify')
  bump(t, 'imagesScanned', result.scanned)
  bump(t, 'imagesUnchanged', result.unchanged)
  for (const entry of result.unavailable) {
    bump(t, 'imageScanUnavailable')
    ctx.log.info('scan: this Coolify has no image scan results', {
      source: entry.subject,
      reason: entry.reason,
    })
  }
  for (const failure of result.errors) {
    // An instance whose inventory already failed this scan counts once.
    const failed = ctx.errors.some((e) => e.source === 'coolify' && e.subject === failure.subject)
    if (!failed) t.failed++
    ctx.repositories.sources.markError(failure.sourceId, failure.error, ctx.now())
    recordError(ctx, { source: 'coolify', subject: failure.subject, error: failure.error })
  }
}

function sourceResults(ctx: ScanContext): Partial<Record<SourceKind, ScanSourceResult>> {
  const out: Partial<Record<SourceKind, ScanSourceResult>> = {}
  for (const kind of ['coolify', 'github', 'osv'] as const) {
    const t = ctx.tallies[kind]
    if (!t) {
      out[kind] = { status: 'skipped', counts: {} }
      continue
    }
    const errors = ctx.errors.filter((e) => e.source === kind)
    out[kind] = {
      status: t.failed > 0 ? 'error' : 'ok',
      counts: { ...t.counts, attempted: t.attempted, failed: t.failed },
      ...(errors.length > 0 && {
        error: `${t.failed} of ${t.attempted} failed. First: ${errors[0]!.subject}: ${errors[0]!.error}`,
      }),
    }
  }
  return out
}

/** Records the outcome on each GitHub source row and the OSV row (Coolify is marked per instance). */
function markSources(ctx: ScanContext, results: Partial<Record<SourceKind, ScanSourceResult>>) {
  for (const [sourceId, t] of ctx.githubTallies) {
    if (t.first) {
      const error = `${t.failed} of ${t.attempted} failed. First: ${t.first.subject}: ${t.first.error}`
      ctx.repositories.sources.markError(sourceId, error, ctx.now())
    } else ctx.repositories.sources.markOk(sourceId, ctx.now())
  }
  const osvId = ctx.sources.osv?.sourceId
  const osv = results.osv
  if (osvId == null || !osv || osv.status === 'skipped') return
  if (osv.error) ctx.repositories.sources.markError(osvId, osv.error, ctx.now())
  else ctx.repositories.sources.markOk(osvId, ctx.now())
}

function overallStatus(tallies: Tallies): ScanSummary['status'] {
  const attempted = Object.values(tallies).filter((t) => t.attempted > 0)
  if (attempted.some((t) => t.failed > 0)) {
    return attempted.every((t) => t.failed === t.attempted) ? 'failed' : 'partial'
  }
  return 'succeeded'
}

/** Fix plans are derived data: a failure is logged and never fails the scan. */
async function savePlans(
  ctx: ScanContext,
  scanRunId: number,
  scans: Map<number, RepoScan>,
): Promise<void> {
  try {
    const plans = await saveScanPlans(ctx.repositories, scanRunId, scans, ctx.now(), {
      osv: ctx.sources.osv?.client ?? null,
      warn: (message, data) => ctx.log.warn(message, data),
    })
    ctx.log.info('scan: fix plans saved', { scanRunId, plans: plans.length })
  } catch (error) {
    ctx.log.warn('scan: fix plans failed', { scanRunId, error: errorMessage(error) })
  }
}

function countChanges(changes: FindingChange[]) {
  return {
    findingsOpened: changes.filter((c) => c.change === 'opened' || c.change === 'reopened').length,
    findingsFixed: changes.filter((c) => c.change === 'fixed').length,
  }
}

/**
 * One full scan: expire snoozes, sync Coolify deployments, scan every
 * deployed repo (plus account repos when enabled) with GitHub and OSV, join
 * the results into findings and blind spots, run the guard checks, and record the run. Per source
 * and per repo failures are recorded and never abort the scan. Never throws:
 * an unexpected failure ends the run as `failed`.
 */
export async function runScan(
  storage: { repositories: Repositories },
  sources: ScanSources,
  options: RunScanOptions = {},
): Promise<ScanSummary> {
  const now = options.now ?? (() => currentTime())
  const ctx: ScanContext = {
    repositories: storage.repositories,
    sources,
    now,
    log: options.log ?? silent,
    tallies: {},
    githubTallies: new Map(),
    listed: new Map(),
    errors: [],
    skipped: skippedPhases(sources),
    progress: (phase, done, total) => {
      try {
        options.onProgress?.({ phase, done, total, skipped: ctx.skipped })
      } catch {
        // Progress is informational; a failing listener never stops the scan.
      }
    },
  }
  const startedAt = now()
  const run = ctx.repositories.scanRuns.start(options.trigger ?? 'manual', startedAt)
  ctx.log.info('scan: started', { scanRunId: run.id })
  const changes: FindingChange[] = []
  let failure: string | null = null

  try {
    // The first phase that runs is known before any await, so status never lags the run row.
    const first = SCAN_PHASES.find((p) => !ctx.skipped.includes(p)) ?? 'matching'
    ctx.progress(first, 0, 0)
    for (const f of expireDeferred(ctx.repositories.findings, now())) {
      changes.push({ findingId: f.id, change: 'expired' })
    }
    const step = ctx.skipped.includes('deployments')
      ? () => {}
      : startPhase(
          ctx,
          'deployments',
          sources.coolify.length + (listsAccountRepos(sources) ? sources.github.length : 0),
        )
    await syncCoolify(ctx, step)
    const accountRepoIds = await syncAccountRepos(ctx, step)
    const index = indexDeployments(ctx.repositories)
    const repos = reposToScan(ctx, index, accountRepoIds)
    const result = await scanRepos(ctx, repos, index, options.concurrency ?? 4)
    changes.push(...result.changes)
    changes.push(
      ...(await checkReleases(ctx, repos, index, result.scans, options.concurrency ?? 4)),
    )
    const mode = sources.settings.imageScan
    const images = await runImageScan(ctx.repositories, sources.coolify, index, {
      mode,
      now: now(),
    })
    changes.push(...images.changes)
    recordImageScan(ctx, images)
    ctx.progress('ranking', 0, 0)
    changes.push(
      ...applyBlindSpots(ctx.repositories, index, result.scans, now(), {
        mode,
        coverage: images.coverage,
      }),
    )
    const guardContext = {
      deployments: index.deployments,
      repos,
      index,
      scans: result.scans,
      support: options.support?.() ?? null,
      supportWindowDays: readSupportWindowDays(ctx.repositories.settings),
      repoFiles: createRepoFileReader({
        sources,
        httpCache: ctx.repositories.httpCache,
        scans: result.scans,
        now,
      }),
      behindReleases: readBehindReleases(ctx.repositories.settings),
      now: now(),
    }
    const guards = options.guards ?? GUARDS
    changes.push(...(await runGuards(ctx.repositories, guards, guardContext, ctx.log)))
    await savePlans(ctx, run.id, result.scans)
  } catch (error) {
    failure = errorMessage(error)
    ctx.log.error('scan: failed unexpectedly', { error: failure })
  }

  const results = sourceResults(ctx)
  markSources(ctx, results)
  const status = failure ? 'failed' : overallStatus(ctx.tallies)
  const counts = countChanges(changes)
  const finishedAt = now()
  ctx.repositories.scanRuns.finish(
    run.id,
    { status, sourceResults: results, ...counts, error: failure },
    finishedAt,
  )
  ctx.log.info('scan: finished', { scanRunId: run.id, status, ...counts })
  return {
    scanRunId: run.id,
    status,
    startedAt,
    finishedAt,
    sourceResults: results,
    ...counts,
    changes,
    errors: ctx.errors,
  }
}

export interface RepoScanSummary {
  repoId: number
  /** `failed` when a source could not read the repo fully; its findings may be stale. */
  status: 'succeeded' | 'failed'
  startedAt: Date
  finishedAt: Date
  /** Findings of the repo this rescan created or changed. */
  changes: FindingChange[]
  errors: ScanError[]
}

/** Why a repo rescan cannot be trusted to say which findings are gone, or null. */
function incompleteReason(scan: RepoScan): ScanError | null {
  const subject = `${scan.repo.owner}/${scan.repo.name}`
  if (scan.health.status === 'error') {
    return { source: 'github', subject, error: scan.health.error }
  }
  if (scan.alerts.status === 'error') {
    return { source: 'github', subject, error: scan.alerts.error }
  }
  if (scan.osv.status === 'error') return { source: 'osv', subject, error: scan.osv.error }
  if (scan.osv.status === 'ok' && scan.osv.value.unparseable.length > 0) {
    const first = scan.osv.value.unparseable[0]!
    return { source: 'osv', subject, error: `could not read ${first.path}: ${first.error}` }
  }
  if (coveringSources(scan).size === 0) {
    return { source: 'github', subject, error: 'no source could read the repo' }
  }
  return null
}

/**
 * A rescan of one repo, for verifying a fix: GitHub alerts and lockfiles of that repo only,
 * written to its findings like a full scan does. It records no scan run (so the schedule and the
 * last scan stay as they are), builds no fix plan and leaves blind spots to the next full scan.
 * `failed` when a source errored or a lockfile could not be read, since findings that source
 * reported then stay open whether or not they are fixed. Never throws.
 */
export async function runRepoScan(
  storage: { repositories: Repositories },
  sources: ScanSources,
  repoId: number,
  options: Pick<RunScanOptions, 'now' | 'log'> = {},
): Promise<RepoScanSummary> {
  const now = options.now ?? (() => currentTime())
  const log = options.log ?? silent
  const { repositories } = storage
  const startedAt = now()
  const done = (
    status: RepoScanSummary['status'],
    changes: FindingChange[],
    errors: ScanError[],
  ) => {
    const summary = { repoId, status, startedAt, finishedAt: now(), changes, errors }
    log.info('scan: repo rescan finished', { repoId, status, changes: changes.length })
    return summary
  }
  const repo = repositories.repos.get(repoId)
  if (!repo) {
    return done(
      'failed',
      [],
      [{ source: 'github', subject: `repo ${repoId}`, error: 'unknown repo' }],
    )
  }
  try {
    const deployments = indexDeployments(repositories).byRepo.get(repo.id) ?? []
    const scan = await collectRepo(sources, repo, deployments)
    const ctx: Pick<ScanContext, 'repositories' | 'now'> = { repositories, now }
    saveRepoHealth(ctx, scan)
    const changes = applyRepoAdvisories(repositories, scan, now())
    const incomplete = incompleteReason(scan)
    return done(incomplete ? 'failed' : 'succeeded', changes, incomplete ? [incomplete] : [])
  } catch (error) {
    const subject = `${repo.owner}/${repo.name}`
    log.warn('scan: repo rescan failed', { repoId, error: errorMessage(error) })
    return done('failed', [], [{ source: 'github', subject, error: errorMessage(error) }])
  }
}
