import type {
  DeployRecord,
  FixRunAfterMerge,
  FixRunDeployment,
  FixRunVerification,
  FixRunWarning,
} from '@hinomi/shared'
import type { DeploymentRow, FixRunRow, RepoRow } from '../db/schema.js'
import type { Logger } from '../log.js'
import type { FixRunEvent, FixRunVerifyPatch, Repositories } from '../repository/index.js'
import {
  compareCommits,
  type GithubClient,
  type GithubCompareStatus,
} from '../sources/github/index.js'
import { readAppDeploys } from './coolify.js'
import {
  afterMergeExpectation,
  deploysOtherBranch,
  expectedApps,
  rescanRetryDelayMs,
  trackingPhase,
  type FixRunTrackingConfig,
} from './tracking.js'
import {
  compareTargets,
  pendingVerification,
  readySince,
  targetedFindingIds,
  waitingLink,
  watchPathsWarning,
} from './verify.js'

// After the merge: link a fix run to the Coolify deploys that ship it (the merge commit or a
// later one, by GitHub's compare API), warn when watch paths would skip the change, then rescan
// the repo and compare the plan's findings. A full scan that finishes after the run became
// ready verifies it too, which is the fallback when rescans of the repo keep failing.

/** A finding change as a scan reports it. */
export interface ScanFindingChange {
  findingId: number
  change: string
}

/** The answer to a request for a rescan of one repo. */
export type RepoRescanOutcome =
  /** A full scan is running; its result arrives through `scanFinished`. */
  | { kind: 'busy' }
  /** The rescan could not read the repo fully, so it cannot say which findings are gone. */
  | { kind: 'failed'; error: string }
  | { kind: 'done'; at: Date; changes: ScanFindingChange[] }

/** Rescans one repo for verification (wired to the scheduler in index.ts). */
export type RepoRescanner = (repoId: number) => Promise<RepoRescanOutcome>

/** A finished full scan, as the tracker reads it. */
export interface FullScanReport {
  scanRunId: number
  status: 'succeeded' | 'partial' | 'failed'
  startedAt: Date
  finishedAt: Date
  /** `owner/name` of every repo a source failed on. */
  failedRepos: readonly string[]
  changes: readonly ScanFindingChange[]
}

export interface VerifyContext {
  repositories: Repositories
  client: GithubClient
  fetch: typeof fetch | undefined
  now: () => Date
  log: Logger
  config: FixRunTrackingConfig
  rescan: RepoRescanner | undefined
  /** Compare answers by `owner/name:base...head`, kept across polls. */
  compareCache: Map<string, GithubCompareStatus | null>
  /** Set to ask for the run again at this time (a busy scheduler). */
  retryAt: (at: Date) => void
}

/** Deploys read per app and poll. */
const DEPLOYS_READ = 20
/** A deploy that finished this long before the merge cannot hold it (clock skew allowance). */
const SKEW_MS = 2 * 60_000
/** Compare answers kept in memory. */
const COMPARE_CACHE_SIZE = 1000
const OPENING = new Set(['opened', 'reopened'])

const DAY = 24 * 60 * 60 * 1000

/** Applications built from git that deploy the repo. */
function gitApps(repositories: Repositories, repoId: number): DeploymentRow[] {
  return repositories.deployments
    .listByRepo(repoId)
    .filter((d) => d.kind === 'application' && d.gitRepository !== null)
}

/** What the run waits for after the merge (the tracker's own rule, see `afterMergeExpectation`). */
export function fixRunAfterMerge(
  repositories: Repositories,
  run: FixRunRow,
  repo: RepoRow | undefined,
): FixRunAfterMerge {
  return afterMergeExpectation(run, gitApps(repositories, run.repoId), repo?.defaultBranch ?? null)
}

function save(
  context: Pick<VerifyContext, 'repositories' | 'now' | 'log'>,
  run: FixRunRow,
  patch: FixRunVerifyPatch,
  event: FixRunEvent | null = null,
): FixRunRow {
  const result = context.repositories.fixRuns.saveVerify(run.id, patch, event, context.now())
  if (!result.ok) {
    if (result.rejection.code === 'conflict') {
      context.log.warn('tracker: a fix run event was refused', {
        runId: run.id,
        event: event?.type,
        reason: result.rejection.message,
      })
    }
    return context.repositories.fixRuns.get(run.id) ?? run
  }
  if (result.run.state !== run.state) {
    context.log.info('tracker: fix run moved', {
      runId: run.id,
      from: run.state,
      to: result.run.state,
      event: event?.type,
    })
  }
  return result.run
}

/** Whether `commit` contains the merge commit, from the cache or GitHub. */
async function relationOf(
  context: VerifyContext,
  repo: RepoRow,
  mergeSha: string,
  commit: string,
): Promise<GithubCompareStatus | null> {
  if (commit === mergeSha) return 'identical'
  const key = `${repo.owner}/${repo.name}:${mergeSha}...${commit}`
  if (context.compareCache.has(key)) return context.compareCache.get(key) ?? null
  const status = await compareCommits(context.client, {
    owner: repo.owner,
    name: repo.name,
    base: mergeSha,
    head: commit,
  })
  if (context.compareCache.size >= COMPARE_CACHE_SIZE) {
    const oldest = context.compareCache.keys().next().value
    if (oldest !== undefined) context.compareCache.delete(oldest)
  }
  context.compareCache.set(key, status)
  return status
}

/** Finished deploys that may hold the merge, oldest first. */
function candidates(items: readonly DeployRecord[], mergedAt: Date): DeployRecord[] {
  const after = mergedAt.getTime() - SKEW_MS
  return items
    .filter((d) => d.status === 'finished' && d.commit !== null && !d.rollback)
    .filter((d) => {
      const at = d.finishedAt ?? d.startedAt
      return at === null || Date.parse(at) >= after
    })
    .sort((a, b) =>
      (a.finishedAt ?? a.startedAt ?? '').localeCompare(b.finishedAt ?? b.startedAt ?? ''),
    )
}

/** Reads one app's deploys and finds the first that ships the merge commit. */
async function linkApp(
  context: VerifyContext,
  run: FixRunRow & { mergeSha: string; mergedAt: Date },
  repo: RepoRow,
  app: DeploymentRow,
): Promise<FixRunDeployment> {
  const base = waitingLink(app)
  const checkedAt = context.now().toISOString()
  const read = await readAppDeploys(context.repositories, app, DEPLOYS_READ, {
    fetch: context.fetch,
  })
  if (!read.ok) return { ...base, checkedAt, error: read.reason }
  const list = candidates(read.items, run.mergedAt).slice(0, context.config.deployComparesPerPoll)
  for (const deploy of list) {
    const relation = await relationOf(context, repo, run.mergeSha, deploy.commit!)
    if (relation === 'identical' || relation === 'ahead') {
      return {
        ...base,
        status: 'deployed',
        deploy: { id: deploy.id, commit: deploy.commit!, relation, finishedAt: deploy.finishedAt },
        checkedAt,
      }
    }
  }
  return { ...base, checkedAt }
}

/** Adds warnings not already recorded (one per code and app). */
function withWarnings(existing: readonly FixRunWarning[], added: FixRunWarning[]): FixRunWarning[] {
  const key = (w: FixRunWarning) => `${w.code}:${w.deploymentId ?? ''}`
  const seen = new Set(existing.map(key))
  return [...existing, ...added.filter((w) => !seen.has(key(w)))]
}

/**
 * One poll of a merged run (or a deployed run waiting for its other apps): links every app of
 * the repo, records `deployment_seen` once one shipped the fix, warns about watch paths, gives
 * up after the wait window, and rescans at once when the run is ready.
 */
export async function pollDeployments(
  context: VerifyContext,
  run: FixRunRow,
  repo: RepoRow,
): Promise<void> {
  const { mergeSha, mergedAt } = run
  if (mergeSha === null || mergedAt === null) return
  const merged = { ...run, mergeSha, mergedAt }
  const now = context.now()
  const previous = new Map((run.deployLinks ?? []).map((link) => [link.deploymentId, link]))
  const branch = repo.defaultBranch
  const links: FixRunDeployment[] = []
  const warnings: FixRunWarning[] = []
  const files = run.result?.patch?.files ?? []
  let shipped = false
  for (const app of gitApps(context.repositories, repo.id)) {
    const before = previous.get(app.id)
    if (before?.status === 'deployed') {
      links.push({ ...before, name: app.name, branch: app.gitBranch })
      continue
    }
    if (deploysOtherBranch(app, branch)) {
      links.push({ ...waitingLink(app), status: 'other_branch', checkedAt: now.toISOString() })
      continue
    }
    const warning = watchPathsWarning(app, files, now)
    if (warning) warnings.push(warning)
    const link = await linkApp(context, merged, repo, app)
    if (link.status === 'deployed') shipped = true
    links.push(link)
  }
  const expected = expectedApps(links)
  const waited = now.getTime() - mergedAt.getTime()
  if (
    run.state === 'merged' &&
    expected.length > 0 &&
    !shipped &&
    waited > context.config.deployGiveUpMs
  ) {
    const days = Math.round(context.config.deployGiveUpMs / DAY)
    warnings.push({
      code: 'deploy_not_seen',
      deploymentId: null,
      message: `No deploy of the merge commit showed up within ${days} days, so Hinomi stopped waiting. An app without automatic deploys needs a deploy by hand; the run stays merged.`,
      at: now.toISOString(),
    })
  }
  const next = save(
    context,
    run,
    { deployLinks: links, warnings: withWarnings(run.warnings, warnings) },
    shipped ? { type: 'deployment_seen' } : null,
  )
  if (shipped) {
    context.log.info('tracker: fix run deployed', {
      runId: run.id,
      apps: links.filter((l) => l.status === 'deployed').map((l) => l.name),
    })
  }
  if (trackingPhase(next, context.now(), context.config) === 'verify') {
    await verifyRun(context, next, repo)
  }
}

/** The run's targeted findings compared after a scan, recorded with `rescan_result`. */
function finish(
  context: Pick<VerifyContext, 'repositories' | 'now' | 'log'>,
  run: FixRunRow,
  scan: NonNullable<FixRunVerification['scan']>,
  changes: readonly ScanFindingChange[],
): FixRunRow {
  const verification = pendingVerification(run)
  const plan = context.repositories.fixPlans.forRepo(run.repoId, run.planScanRunId)?.plan ?? null
  const targeted = targetedFindingIds(plan, run.result ?? null, run.kind)
  if (targeted === null) {
    return save(context, run, {
      verification: {
        ...verification,
        status: 'scheduled_scan',
        scan,
        lastError: `The fix plan of scan ${run.planScanRunId} is gone, so Hinomi cannot tell which findings the run targeted.`,
        nextAttemptAt: null,
      },
    })
  }
  const opened = changes.filter((c) => OPENING.has(c.change)).map((c) => c.findingId)
  const stateOf = (id: number) => context.repositories.findings.get(id)?.state
  const repoOf = (id: number) => context.repositories.findings.get(id)?.repoId
  const compared = compareTargets(
    targeted,
    stateOf,
    opened.filter((id) => repoOf(id) === run.repoId),
  )
  const done: FixRunVerification = {
    ...verification,
    status: 'done',
    scan,
    targeted,
    ...compared,
    lastError: null,
    nextAttemptAt: null,
  }
  context.log.info('tracker: fix run verified by a rescan', {
    runId: run.id,
    scan: scan.kind,
    targeted: targeted.length,
    cleared: compared.cleared.length,
    stillOpen: compared.stillOpen.length,
    new: compared.new.length,
  })
  return save(
    context,
    run,
    { verification: done },
    {
      type: 'rescan_result',
      cleared: compared.stillOpen.length === 0,
      remaining: compared.stillOpen.length,
    },
  )
}

/**
 * Rescans the repo and compares the plan's findings. A busy scheduler is asked again shortly
 * (a full scan may verify the run first); a failed rescan is retried with a growing delay, and
 * after the last try the next scheduled scan verifies the run.
 */
export async function verifyRun(
  context: VerifyContext,
  run: FixRunRow,
  repo: RepoRow,
): Promise<void> {
  if (!context.rescan) return
  const verification = pendingVerification(run)
  let current = run
  if (!run.verification) current = save(context, run, { verification })
  let outcome: RepoRescanOutcome
  try {
    outcome = await context.rescan(repo.id)
  } catch (error) {
    outcome = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  if (outcome.kind === 'busy') {
    context.retryAt(new Date(context.now().getTime() + context.config.rescanBusyMs))
    return
  }
  // A full scan may have verified the run while the rescan ran.
  const fresh = context.repositories.fixRuns.get(run.id) ?? current
  if (fresh.state !== current.state || fresh.verification?.status === 'done') return
  if (outcome.kind === 'done') {
    finish(
      context,
      fresh,
      { kind: 'repo', scanRunId: null, at: outcome.at.toISOString() },
      outcome.changes,
    )
    return
  }
  const attempts = verification.attempts + 1
  const last = attempts >= context.config.rescanMaxAttempts
  const next = new Date(context.now().getTime() + rescanRetryDelayMs(attempts, context.config))
  context.log.warn('tracker: the verification rescan failed', {
    runId: run.id,
    attempts,
    error: outcome.error,
  })
  save(context, fresh, {
    verification: {
      ...verification,
      status: last ? 'scheduled_scan' : 'retrying',
      attempts,
      lastError: outcome.error,
      nextAttemptAt: last ? null : next.toISOString(),
    },
  })
}

/**
 * A full scan finished: verifies every run that waits for a rescan, became ready before the
 * scan started, and whose repo the scan read without errors.
 */
export function verifyFromFullScan(
  context: Pick<VerifyContext, 'repositories' | 'now' | 'log' | 'config'>,
  report: FullScanReport,
): number {
  if (report.status === 'failed') return 0
  const failed = new Set(report.failedRepos.map((r) => r.toLowerCase()))
  let verified = 0
  for (const run of context.repositories.fixRuns.listActive()) {
    if (!['merged', 'deployed', 'nothing_to_do'].includes(run.state)) continue
    if (run.verification?.status === 'done') continue
    // Waiting for the next scheduled scan, or ready for a rescan (not still waiting for apps).
    const phase = trackingPhase(run, report.startedAt, context.config)
    const scheduled = run.verification?.status === 'scheduled_scan'
    if (!scheduled && phase !== 'verify') continue
    if (readySince(run).getTime() > report.startedAt.getTime()) continue
    const repo = context.repositories.repos.get(run.repoId)
    if (!repo || failed.has(`${repo.owner}/${repo.name}`.toLowerCase())) continue
    if (!repo.lastScannedAt || repo.lastScannedAt.getTime() < report.startedAt.getTime()) continue
    const scan = {
      kind: 'full' as const,
      scanRunId: report.scanRunId,
      at: report.finishedAt.toISOString(),
    }
    const next = finish(context, run, scan, report.changes)
    if (next.state === 'verified' || next.state === 'not_cleared') verified += 1
  }
  return verified
}
