import type { FixRunDeployment, FixRunState } from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'

// How often the tracker looks at a fix run, as pure functions of the run and the time
// (docs/design/fix-runner.md, section 6.3). The tracker itself is in tracker.ts.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Cadences, windows and caps of fix run tracking. */
export const FIX_RUN_TRACKING = {
  /** Dispatched, queued and running: every 20 s for the first 5 minutes, then every minute. */
  runFastMs: 20 * SECOND,
  runFastForMs: 5 * MINUTE,
  runMs: MINUTE,
  /** A run without a GitHub run id is matched by run name for this long, then it is lost. */
  linkWindowMs: 15 * MINUTE,
  /** Running longer than the job timeouts (apply 20 min, publish 10 min) plus 10 minutes. */
  runLostAfterMs: 40 * MINUTE,
  /** Dispatched or queued for longer than this: no runner ever picked it up. */
  queueLostAfterMs: 6 * HOUR,
  /** A webhook or local run without a result this long after the dispatch is lost. */
  externalLostAfterMs: 2 * HOUR,
  /** A successful run without its result artifact yet is asked again for this long. */
  artifactWaitMs: 5 * MINUTE,
  /** PR open, checks pending: PR and checks every 2 minutes. */
  prMs: 2 * MINUTE,
  /** Checks done: every 10 minutes, every hour once the checks settled 3 days ago. */
  checksDoneMs: 10 * MINUTE,
  checksDoneSlowAfterMs: 3 * DAY,
  checksDoneSlowMs: HOUR,
  /** No check reported this soon after the PR opened means not started yet, not `none`. */
  checksNoneGraceMs: 10 * MINUTE,
  /** Recently ended runs (failed, cancelled, closed unmerged): every 30 minutes for 7 days. */
  endedMs: 30 * MINUTE,
  endedForMs: 7 * DAY,
  /** Opening the fix PR again after a transient failure: 30 s doubling up to 15 min, 10 tries. */
  publishRetryBaseMs: 30 * SECOND,
  publishRetryMaxMs: 15 * MINUTE,
  publishMaxAttempts: 10,
  /** Merged: read the repo's Coolify deploys every 2 minutes for an hour, then every 15. */
  deployMs: 2 * MINUTE,
  deployFastForMs: HOUR,
  deploySlowMs: 15 * MINUTE,
  /** No deploy of the merge commit after this long: stop waiting, warn, stay merged. */
  deployGiveUpMs: 3 * DAY,
  /** Once one app shipped the fix, the others are waited for this long before the rescan. */
  otherAppsWaitMs: HOUR,
  /** Finished deploys compared with the merge commit per app and poll (answers are cached). */
  deployComparesPerPoll: 5,
  /** A failed rescan of the repo is tried again after 5 minutes, doubling, 5 tries in all. */
  rescanRetryBaseMs: 5 * MINUTE,
  rescanMaxAttempts: 5,
  /** A full scan is running: ask again after this long (its result may verify the run first). */
  rescanBusyMs: 2 * MINUTE,
  /** Requests one tick may start (a run being polled finishes its step). */
  requestsPerTick: 40,
  /** Requests per rolling hour, shared by every tracked run. */
  requestsPerHour: 600,
  /** Below this many requests left in GitHub's window, tracking waits for the reset. */
  rateLimitReserve: 500,
  /** Ticks are at least this far apart, and at most `idleDelayMs` when nothing is due. */
  minDelayMs: 5 * SECOND,
  idleDelayMs: 20 * SECOND,
} as const

export type FixRunTrackingConfig = { [K in keyof typeof FIX_RUN_TRACKING]: number }

/**
 * What polling does with a run: `link` finds its workflow run by run name, `run` follows the
 * workflow run, `wait` waits for the result of a webhook or local run (no request, only the
 * lost timeout), `publish` opens the fix PR, `pr` follows the PR and its checks, `ended_run` and
 * `ended_pr` watch a recently ended run for a re-run or a reopened PR, `deploy` links a merged
 * run to the Coolify deploys that ship it, `verify` rescans the repo and compares the findings.
 */
export type TrackingPhase =
  'link' | 'run' | 'wait' | 'publish' | 'pr' | 'ended_run' | 'ended_pr' | 'deploy' | 'verify'

/** States before the fix branch is pushed. */
export const BEFORE_PUSH: readonly FixRunState[] = ['pending', 'dispatched', 'queued', 'running']
export const TRACKED_PR_STATES: readonly FixRunState[] = [
  'pr_open',
  'checks_pending',
  'checks_passing',
  'checks_failing',
  'checks_none',
]
/** Ended states the tracker keeps watching for `endedForMs`. */
export const WATCHED_ENDED_STATES = ['failed', 'cancelled', 'closed_unmerged'] as const

/** When the run was handed to GitHub, or created when that never happened. */
export function dispatchTime(run: FixRunRow): Date {
  return run.dispatchedAt ?? run.createdAt
}

/** Apps that ship the fix: every linked app except those deploying another branch. */
export function expectedApps(links: readonly FixRunDeployment[]): FixRunDeployment[] {
  return links.filter((link) => link.status !== 'other_branch')
}

/** True when the run's verification waits for the next scheduled scan, not for a rescan. */
function waitsForScheduledScan(run: FixRunRow): boolean {
  return run.verification?.status === 'scheduled_scan' || run.verification?.status === 'done'
}

/**
 * After the merge: `deploy` while the apps of the repo have not all shipped the fix (merged
 * until the give-up warning is written, deployed for `otherAppsWaitMs` after the first app),
 * then `verify`. A repo with no app to wait for goes straight to `verify`.
 */
function afterMergePhase(
  run: FixRunRow,
  now: Date,
  config: FixRunTrackingConfig,
): TrackingPhase | null {
  const links = run.deployLinks
  const verify = waitsForScheduledScan(run) ? null : 'verify'
  if (run.state === 'merged') {
    if (links !== null && expectedApps(links).length === 0) return verify
    if (run.warnings.some((w) => w.code === 'deploy_not_seen')) return null
    return 'deploy'
  }
  const waiting = (links ?? []).some((link) => link.status === 'waiting')
  const since = run.deployedAt ?? run.stateChangedAt
  if (waiting && now.getTime() - since.getTime() < config.otherAppsWaitMs) return 'deploy'
  return verify
}

/**
 * The phase of a run, or null when the tracker leaves it alone (a merged run that gave up on a
 * deployment, a verification left to the next scheduled scan, ended runs that never change).
 */
export function trackingPhase(
  run: FixRunRow,
  now: Date,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): TrackingPhase | null {
  if (BEFORE_PUSH.includes(run.state)) {
    // Webhook and local results arrive by callback or from the local process, not from GitHub.
    if (run.runner !== 'github_actions') return 'wait'
    return run.githubRunId === null ? 'link' : 'run'
  }
  if (run.state === 'branch_pushed') return 'publish'
  if (TRACKED_PR_STATES.includes(run.state)) return run.prNumber === null ? null : 'pr'
  if (run.state === 'merged' || run.state === 'deployed') return afterMergePhase(run, now, config)
  if (run.state === 'nothing_to_do') return waitsForScheduledScan(run) ? null : 'verify'
  const recent = run.endedAt !== null && now.getTime() - run.endedAt.getTime() <= config.endedForMs
  if (!recent) return null
  if ((run.state === 'failed' || run.state === 'cancelled') && run.githubRunId !== null) {
    return 'ended_run'
  }
  if (run.state === 'closed_unmerged' && run.prNumber !== null) return 'ended_pr'
  return null
}

/** How long after the last poll the run is due again in its phase. */
export function pollIntervalMs(
  run: FixRunRow,
  phase: TrackingPhase,
  now: Date,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): number {
  switch (phase) {
    case 'wait':
      return config.runMs
    case 'link':
    case 'run': {
      const age = now.getTime() - dispatchTime(run).getTime()
      return age < config.runFastForMs ? config.runFastMs : config.runMs
    }
    case 'publish':
      return config.publishRetryBaseMs
    case 'pr': {
      if (run.state === 'pr_open' || run.state === 'checks_pending') return config.prMs
      const settled = run.checksUpdatedAt ?? run.prOpenedAt ?? run.stateChangedAt
      const age = now.getTime() - settled.getTime()
      return age < config.checksDoneSlowAfterMs ? config.checksDoneMs : config.checksDoneSlowMs
    }
    case 'ended_run':
    case 'ended_pr':
      return config.endedMs
    case 'deploy': {
      if (run.state === 'deployed') return config.deployMs
      const age = now.getTime() - (run.mergedAt ?? run.stateChangedAt).getTime()
      return age < config.deployFastForMs ? config.deployMs : config.deploySlowMs
    }
    case 'verify':
      return rescanRetryDelayMs(run.verification?.attempts ?? 0, config)
  }
}

/** Wait before the next rescan after `attempts` failed ones: none before the first. */
export function rescanRetryDelayMs(
  attempts: number,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): number {
  if (attempts <= 0) return 0
  return config.rescanRetryBaseMs * 2 ** (attempts - 1)
}

/** Wait before publish attempt `attempt + 1` after `attempt` transient failures (1 based). */
export function publishRetryDelayMs(
  attempt: number,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): number {
  const delay = config.publishRetryBaseMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(config.publishRetryMaxMs, delay)
}

/**
 * Why a run that GitHub still reports as not finished should be given up, or null. Running
 * counts from when Hinomi first saw it running, queued from the dispatch.
 */
export function lostReason(
  run: FixRunRow,
  now: Date,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): string | null {
  const minutes = (ms: number) => Math.round(ms / MINUTE)
  if (run.runner !== 'github_actions') {
    if (!BEFORE_PUSH.includes(run.state)) return null
    if (now.getTime() - dispatchTime(run).getTime() <= config.externalLostAfterMs) return null
    return `The ${run.runner} runner sent no result within ${minutes(config.externalLostAfterMs)} minutes of the dispatch, so Hinomi stopped waiting for it.`
  }
  if (run.state === 'running' && run.startedAt) {
    if (now.getTime() - run.startedAt.getTime() > config.runLostAfterMs) {
      return `The workflow run did not finish within ${minutes(config.runLostAfterMs)} minutes of starting, so Hinomi stopped following it.`
    }
    return null
  }
  if (run.state === 'pending' || run.state === 'dispatched' || run.state === 'queued') {
    if (now.getTime() - dispatchTime(run).getTime() > config.queueLostAfterMs) {
      return `The workflow run was still waiting for a runner ${minutes(config.queueLostAfterMs) / 60} hours after the dispatch, so Hinomi stopped following it.`
    }
  }
  return null
}
