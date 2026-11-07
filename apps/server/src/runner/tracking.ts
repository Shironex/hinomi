import type { FixRunState } from '@hinomi/shared'
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
 * workflow run, `publish` opens the fix PR, `pr` follows the PR and its checks, `ended_run` and
 * `ended_pr` watch a recently ended run for a re-run or a reopened PR.
 */
export type TrackingPhase = 'link' | 'run' | 'publish' | 'pr' | 'ended_run' | 'ended_pr'

const BEFORE_PUSH: readonly FixRunState[] = ['pending', 'dispatched', 'queued', 'running']
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

/**
 * The phase of a run, or null when the tracker leaves it alone (merged, deployed and
 * nothing_to_do wait for a deployment or a rescan; other ended runs never change).
 */
export function trackingPhase(
  run: FixRunRow,
  now: Date,
  config: FixRunTrackingConfig = FIX_RUN_TRACKING,
): TrackingPhase | null {
  if (BEFORE_PUSH.includes(run.state)) return run.githubRunId === null ? 'link' : 'run'
  if (run.state === 'branch_pushed') return 'publish'
  if (TRACKED_PR_STATES.includes(run.state)) return run.prNumber === null ? null : 'pr'
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
  }
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
