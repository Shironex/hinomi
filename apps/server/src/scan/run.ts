import type { ScanRunStatus, ScanTrigger, SourceKind } from '@hinomi/shared'
import type { RepoRow, ScanSourceResult } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { mapLimit } from '../sources/osv/client.js'
import { applyRepoAdvisories, type FindingChange } from './apply.js'
import { applyBlindSpots } from './blind-spots.js'
import { collectRepo, errorMessage, type RepoScan } from './collect.js'
import { indexDeployments, syncDeployments, type DeploymentIndex } from './deployments.js'
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
  errors: ScanError[]
}

function recordError(ctx: ScanContext, error: ScanError): void {
  ctx.errors.push(error)
  ctx.log.warn(`scan: ${error.source} failed for ${error.subject}`, { error: error.error })
}

async function syncCoolify(ctx: ScanContext): Promise<void> {
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
  }
}

/** Upserts every repo the GitHub token sees, for the everything-else view. */
async function syncAccountRepos(ctx: ScanContext): Promise<number[]> {
  const github = ctx.sources.github
  if (!github || !ctx.sources.settings.includeAccountRepos) return []
  try {
    const repos = await github.listAccountRepos()
    return ctx.repositories.db.transaction(() =>
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
  } catch (error) {
    const t = tally(ctx.tallies, 'github')
    t.attempted++
    t.failed++
    recordError(ctx, { source: 'github', subject: 'account repos', error: errorMessage(error) })
    return []
  }
}

function reposToScan(ctx: ScanContext, index: DeploymentIndex, accountRepoIds: number[]) {
  const ids = new Set([...index.byRepo.keys(), ...accountRepoIds])
  return [...ids]
    .map((id) => ctx.repositories.repos.get(id))
    .filter((r): r is RepoRow => r !== undefined)
}

function tallyRepo(ctx: ScanContext, scan: RepoScan): void {
  const name = `${scan.repo.owner}/${scan.repo.name}`
  if (ctx.sources.github) {
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
  if (ctx.sources.osv) {
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
}

function saveRepoHealth(ctx: ScanContext, scan: RepoScan): void {
  const { repos } = ctx.repositories
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

/** Fetches every repo in parallel, then writes each one. One bad repo never stops the others. */
async function scanRepos(
  ctx: ScanContext,
  repos: RepoRow[],
  index: DeploymentIndex,
  concurrency: number,
): Promise<{ scans: Map<number, RepoScan>; changes: FindingChange[] }> {
  const results = await mapLimit(repos, concurrency, (repo) =>
    collectRepo(ctx.sources, repo, index.byRepo.get(repo.id) ?? []),
  )
  const scans = new Map<number, RepoScan>()
  const changes: FindingChange[] = []
  for (const scan of results) {
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
  }
  return { scans, changes }
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

/** Records the outcome on the GitHub and OSV source rows (Coolify is marked per instance). */
function markSources(ctx: ScanContext, results: Partial<Record<SourceKind, ScanSourceResult>>) {
  const ids: [SourceKind, number | null | undefined][] = [
    ['github', ctx.sources.github?.sourceId],
    ['osv', ctx.sources.osv?.sourceId],
  ]
  for (const [kind, id] of ids) {
    const result = results[kind]
    if (id == null || !result || result.status === 'skipped') continue
    if (result.error) ctx.repositories.sources.markError(id, result.error, ctx.now())
    else ctx.repositories.sources.markOk(id, ctx.now())
  }
}

function overallStatus(tallies: Tallies): ScanSummary['status'] {
  const attempted = Object.values(tallies).filter((t) => t.attempted > 0)
  if (attempted.some((t) => t.failed > 0)) {
    return attempted.every((t) => t.failed === t.attempted) ? 'failed' : 'partial'
  }
  return 'succeeded'
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
 * the results into findings and blind spots, and record the run. Per source
 * and per repo failures are recorded and never abort the scan. Never throws:
 * an unexpected failure ends the run as `failed`.
 */
export async function runScan(
  storage: { repositories: Repositories },
  sources: ScanSources,
  options: RunScanOptions = {},
): Promise<ScanSummary> {
  const now = options.now ?? (() => new Date())
  const ctx: ScanContext = {
    repositories: storage.repositories,
    sources,
    now,
    log: options.log ?? silent,
    tallies: {},
    errors: [],
  }
  const startedAt = now()
  const run = ctx.repositories.scanRuns.start(options.trigger ?? 'manual', startedAt)
  ctx.log.info('scan: started', { scanRunId: run.id })
  const changes: FindingChange[] = []
  let failure: string | null = null

  try {
    for (const f of expireDeferred(ctx.repositories.findings, now())) {
      changes.push({ findingId: f.id, change: 'expired' })
    }
    await syncCoolify(ctx)
    const accountRepoIds = await syncAccountRepos(ctx)
    const index = indexDeployments(ctx.repositories)
    const repos = reposToScan(ctx, index, accountRepoIds)
    const result = await scanRepos(ctx, repos, index, options.concurrency ?? 4)
    changes.push(...result.changes)
    changes.push(...applyBlindSpots(ctx.repositories, index, result.scans, now()))
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
