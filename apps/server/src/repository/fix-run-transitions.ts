import { isFixRunTerminal, type FixRunState } from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'

// The fix run state machine as a pure function of (run, event, time), so polling, the optional
// webhook and tests all go through the same edges. The repository applies the result in a
// transaction (fix-runs.ts).
//
//   pending -> dispatched -> queued -> running -> branch_pushed -> pr_open -> checks_pending
//   checks_pending <-> checks_passing <-> checks_failing <-> checks_none (checks rerun on a new
//   push; checks_none when the repo runs no checks on the PR)
//   pr_open or checks_* -> merged -> deployed -> verified | not_cleared
//   running -> nothing_to_do -> verified | not_cleared (empty diff, straight to a rescan)
//   before the PR: failed, cancelled (the run), lost (polling gave up)
//   before the merge: superseded (a newer dispatch), closed_unmerged (PR closed)
//   back from the end: closed_unmerged -> pr_open (PR reopened), failed or cancelled -> queued |
//   running (the same workflow run re-run on GitHub, a higher attempt)
//
// Polling can miss states, so a run may jump forward (dispatched straight to branch_pushed). An
// event for a state the run already left is `stale`; one that makes no sense from the current
// state is `not_allowed`. Repeating the event that led to the current state is a no-op.

/** What polling and webhooks report about a run. */
export type FixRunEvent =
  /** The runner accepted the dispatch. GitHub returns the run id with `return_run_details`. */
  | { type: 'dispatch_accepted'; githubRunId: number | null; githubRunAttempt?: number | null }
  /** The run id was found later, by matching the run name (no state change). */
  | { type: 'run_linked'; githubRunId: number; githubRunAttempt?: number | null }
  | { type: 'run_queued'; githubRunId?: number; githubRunAttempt?: number | null }
  | { type: 'run_started'; githubRunId?: number; githubRunAttempt?: number | null }
  /**
   * The workflow run finished. Sent once its result artifact was read, so a successful run is
   * known to have either pushed the branch or found nothing to change (`nothingToDo`).
   */
  | {
      type: 'run_completed'
      conclusion: FixRunConclusion
      nothingToDo?: boolean
      headSha?: string | null
      githubRunId?: number
      githubRunAttempt?: number | null
    }
  | { type: 'branch_pushed'; headSha: string }
  | { type: 'pr_opened'; number: number; url: string; draft: boolean }
  /** Hinomi or a human changed the PR's draft state (no state change). */
  | { type: 'pr_draft_changed'; draft: boolean }
  | { type: 'checks_updated'; status: FixRunChecksStatus; headSha?: string }
  | { type: 'pr_merged'; mergeSha: string }
  | { type: 'pr_closed' }
  /** A closed fix PR was reopened. */
  | { type: 'pr_reopened'; number: number }
  /** A deployment of the merge commit finished. */
  | { type: 'deployment_seen' }
  /** A rescan after the merge (or after an empty diff) compared the plan's findings. */
  | { type: 'rescan_result'; cleared: boolean; remaining: number }
  | { type: 'superseded'; byRunId: number }
  /** The dispatch, the result or the PR could not be completed. `reason` is shown as is. */
  | { type: 'failed'; reason: string }
  | { type: 'lost'; reason: string }

export type FixRunEventType = FixRunEvent['type']

/** Conclusions of a finished workflow run that Hinomi tells apart. */
export type FixRunConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out'

/** The combined state of the checks on the PR's head commit. */
export type FixRunChecksStatus = 'pending' | 'passing' | 'failing' | 'none'

/** The fields of a run the state machine reads and writes. */
export type FixRunTracked = Pick<
  FixRunRow,
  | 'state'
  | 'stateReason'
  | 'githubRunId'
  | 'githubRunAttempt'
  | 'headSha'
  | 'prNumber'
  | 'prUrl'
  | 'prDraft'
  | 'mergeSha'
  | 'dispatchedAt'
  | 'startedAt'
  | 'completedAt'
  | 'pushedAt'
  | 'prOpenedAt'
  | 'checksUpdatedAt'
  | 'mergedAt'
  | 'closedAt'
  | 'deployedAt'
  | 'rescannedAt'
  | 'endedAt'
  | 'stateChangedAt'
>

export type FixRunRejectionCode = 'terminal' | 'stale' | 'not_allowed' | 'conflict'

export interface FixRunRejection {
  code: FixRunRejectionCode
  message: string
}

export type FixRunTransition<T extends FixRunTracked> =
  { ok: true; run: T; changed: boolean } | { ok: false; rejection: FixRunRejection }

const BEFORE_PUSH = ['pending', 'dispatched', 'queued', 'running'] as const
const PR_STATES = [
  'pr_open',
  'checks_pending',
  'checks_passing',
  'checks_failing',
  'checks_none',
] as const
const BEFORE_MERGE = [...BEFORE_PUSH, 'branch_pushed', ...PR_STATES] as const

/**
 * The states each event may move a run out of (to the event's target). Repeating the event in
 * its target state is always allowed and handled separately. Events without a target change
 * fields only.
 */
export const FIX_RUN_EVENT_SOURCES: Record<FixRunEventType, readonly FixRunState[]> = {
  dispatch_accepted: ['pending'],
  run_linked: [...BEFORE_MERGE, 'merged', 'deployed', 'nothing_to_do'],
  run_queued: ['pending', 'dispatched'],
  run_started: ['pending', 'dispatched', 'queued'],
  run_completed: BEFORE_PUSH,
  branch_pushed: BEFORE_PUSH,
  pr_opened: [...BEFORE_PUSH, 'branch_pushed'],
  pr_draft_changed: PR_STATES,
  checks_updated: PR_STATES,
  pr_merged: PR_STATES,
  pr_closed: PR_STATES,
  // Only from closed_unmerged, see FIX_RUN_REVIVALS.
  pr_reopened: [],
  deployment_seen: ['merged'],
  rescan_result: ['merged', 'deployed', 'nothing_to_do'],
  superseded: [...BEFORE_MERGE, 'nothing_to_do'],
  failed: [...BEFORE_PUSH, 'branch_pushed'],
  lost: [...BEFORE_MERGE, 'merged', 'deployed', 'nothing_to_do'],
}

/** The state an event moves a run to, or null for events that only change fields. */
export function fixRunEventTarget(event: FixRunEvent): FixRunState | null {
  switch (event.type) {
    case 'run_linked':
    case 'pr_draft_changed':
      return null
    case 'dispatch_accepted':
      return 'dispatched'
    case 'run_queued':
      return 'queued'
    case 'run_started':
      return 'running'
    case 'run_completed':
      return completedTarget(event.conclusion, event.nothingToDo === true)
    case 'branch_pushed':
      return 'branch_pushed'
    case 'pr_opened':
    case 'pr_reopened':
      return 'pr_open'
    case 'checks_updated':
      return `checks_${event.status}`
    case 'pr_merged':
      return 'merged'
    case 'pr_closed':
      return 'closed_unmerged'
    case 'deployment_seen':
      return 'deployed'
    case 'rescan_result':
      return event.cleared ? 'verified' : 'not_cleared'
    case 'superseded':
      return 'superseded'
    case 'failed':
      return 'failed'
    case 'lost':
      return 'lost'
  }
}

function completedTarget(conclusion: FixRunConclusion, nothingToDo: boolean): FixRunState {
  if (conclusion === 'cancelled') return 'cancelled'
  if (conclusion !== 'success') return 'failed'
  return nothingToDo ? 'nothing_to_do' : 'branch_pushed'
}

// Order along the happy path, to tell a stale event from one that is not allowed.
const PROGRESS: Record<FixRunState, number> = {
  pending: 0,
  dispatched: 1,
  queued: 2,
  running: 3,
  branch_pushed: 4,
  nothing_to_do: 4,
  pr_open: 5,
  checks_pending: 6,
  checks_passing: 7,
  checks_failing: 7,
  checks_none: 7,
  merged: 8,
  deployed: 9,
  verified: 10,
  not_cleared: 10,
  failed: 10,
  cancelled: 10,
  closed_unmerged: 10,
  superseded: 10,
  lost: 10,
}

/** Why a run ended in its state, when the state alone does not say. */
function reasonFor(event: FixRunEvent): string | null {
  switch (event.type) {
    case 'run_completed':
      return event.conclusion === 'success' ? null : `run_${event.conclusion}`
    case 'rescan_result':
      return event.cleared ? null : `${event.remaining} findings still open`
    case 'superseded':
      return `superseded by run ${event.byRunId}`
    case 'failed':
    case 'lost':
      return event.reason
    default:
      return null
  }
}

type Patch = Partial<FixRunTracked>

function reject(code: FixRunRejectionCode, message: string): FixRunTransition<never> {
  return { ok: false, rejection: { code, message } }
}

/** Fields an event carries, whatever the state change. A conflict is returned as a string. */
function fieldsOf(run: FixRunTracked, event: FixRunEvent, at: Date): Patch | string {
  switch (event.type) {
    case 'dispatch_accepted':
    case 'run_linked':
    case 'run_queued':
    case 'run_started':
      return runIdentity(run, event.githubRunId, event.githubRunAttempt)
    case 'run_completed': {
      const identity = runIdentity(run, event.githubRunId, event.githubRunAttempt)
      if (typeof identity === 'string') return identity
      return {
        ...identity,
        ...(event.headSha && { headSha: event.headSha }),
        completedAt: run.completedAt ?? at,
      }
    }
    case 'branch_pushed':
      return { headSha: event.headSha }
    case 'pr_opened':
      if (run.prNumber !== null && run.prNumber !== event.number) {
        return `run already tracks PR #${run.prNumber}, not #${event.number}`
      }
      return { prNumber: event.number, prUrl: event.url, prDraft: event.draft }
    case 'pr_reopened':
      if (run.prNumber !== event.number) {
        return `run tracks PR #${run.prNumber ?? 'none'}, not #${event.number}`
      }
      return {}
    case 'pr_draft_changed':
      return { prDraft: event.draft }
    case 'checks_updated':
      return event.headSha ? { headSha: event.headSha } : {}
    case 'pr_merged':
      return { mergeSha: event.mergeSha, prDraft: false }
    default:
      return {}
  }
}

function runIdentity(
  run: FixRunTracked,
  githubRunId: number | null | undefined,
  githubRunAttempt: number | null | undefined,
): Patch | string {
  if (githubRunId === undefined || githubRunId === null) return {}
  if (run.githubRunId !== null && run.githubRunId !== githubRunId) {
    return `run already linked to workflow run ${run.githubRunId}, not ${githubRunId}`
  }
  const attempt =
    githubRunAttempt === undefined || githubRunAttempt === null
      ? run.githubRunAttempt
      : Math.max(githubRunAttempt, run.githubRunAttempt ?? 0)
  return { githubRunId, githubRunAttempt: attempt }
}

/** Timestamps written when a run enters a state (kept when it was already set). */
function enteredAt(run: FixRunTracked, to: FixRunState, at: Date): Patch {
  const patch: Patch = { stateChangedAt: at }
  if (to === 'dispatched') patch.dispatchedAt = run.dispatchedAt ?? at
  if (to === 'running') patch.startedAt = run.startedAt ?? at
  if (to === 'branch_pushed') patch.pushedAt = run.pushedAt ?? at
  if (to === 'pr_open') patch.prOpenedAt = run.prOpenedAt ?? at
  if (to.startsWith('checks_')) patch.checksUpdatedAt = at
  if (to === 'merged') patch.mergedAt = run.mergedAt ?? at
  if (to === 'closed_unmerged') patch.closedAt = run.closedAt ?? at
  if (to === 'deployed') patch.deployedAt = run.deployedAt ?? at
  if (to === 'verified' || to === 'not_cleared') patch.rescannedAt = at
  if (isFixRunTerminal(to)) patch.endedAt = at
  return patch
}

function withPatch<T extends FixRunTracked>(run: T, patch: Patch): FixRunTransition<T> {
  const keys = Object.keys(patch) as (keyof FixRunTracked)[]
  const changed = keys.some((key) => !sameValue(run[key], patch[key]))
  return { ok: true, run: changed ? { ...run, ...patch } : run, changed }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/**
 * The only ways out of an ended state: a reopened PR, and a re-run of the same workflow run with
 * a higher attempt. Anything else on an ended run is a `terminal` rejection.
 */
export const FIX_RUN_REVIVALS: Partial<Record<FixRunState, readonly FixRunEventType[]>> = {
  closed_unmerged: ['pr_reopened'],
  failed: ['run_queued', 'run_started'],
  cancelled: ['run_queued', 'run_started'],
}

/** A revival of an ended run, or null when the event does not revive it. */
function revive<T extends FixRunTracked>(
  run: T,
  event: FixRunEvent,
  at: Date,
): FixRunTransition<T> | null {
  if (!FIX_RUN_REVIVALS[run.state]?.includes(event.type)) return null
  if (event.type === 'run_queued' || event.type === 'run_started') {
    const attempt = event.githubRunAttempt ?? null
    const rerun =
      run.githubRunId !== null &&
      event.githubRunId === run.githubRunId &&
      attempt !== null &&
      attempt > (run.githubRunAttempt ?? 1)
    if (!rerun) return null
  }
  const to = fixRunEventTarget(event)
  if (to === null) return null
  const fields = fieldsOf(run, event, at)
  if (typeof fields === 'string') return reject('conflict', fields)
  return withPatch(run, {
    ...fields,
    ...enteredAt(run, to, at),
    ...(to === 'pr_open' ? { closedAt: null } : { completedAt: null, startedAt: null }),
    ...(to === 'running' && { startedAt: at }),
    state: to,
    stateReason: null,
    endedAt: null,
  })
}

/**
 * Applies one event to a run. Returns the next run (the same object when nothing changed) or a
 * rejection; never throws. `at` is when Hinomi observed the event.
 */
export function transitionFixRun<T extends FixRunTracked>(
  run: T,
  event: FixRunEvent,
  at: Date,
): FixRunTransition<T> {
  const from = run.state
  const to = fixRunEventTarget(event)

  // Repeating the event that led here: nothing moves. A terminal run keeps what it recorded.
  if (to === from) {
    if (isFixRunTerminal(from)) return { ok: true, run, changed: false }
    const fields = fieldsOf(run, event, at)
    if (typeof fields === 'string') return reject('conflict', fields)
    return withPatch(run, fields)
  }
  const revived = revive(run, event, at)
  if (revived) return revived
  if (isFixRunTerminal(from)) {
    return reject('terminal', `run is ${from}; ${event.type} ignored`)
  }
  if (!FIX_RUN_EVENT_SOURCES[event.type].includes(from)) {
    const stale = to !== null && PROGRESS[to] < PROGRESS[from]
    return reject(
      stale ? 'stale' : 'not_allowed',
      `${event.type} cannot move a ${from} run${to === null ? '' : ` to ${to}`}`,
    )
  }
  const fields = fieldsOf(run, event, at)
  if (typeof fields === 'string') return reject('conflict', fields)
  if (to === null) return withPatch(run, fields)
  return withPatch(run, {
    ...fields,
    ...enteredAt(run, to, at),
    state: to,
    stateReason: reasonFor(event),
  })
}
