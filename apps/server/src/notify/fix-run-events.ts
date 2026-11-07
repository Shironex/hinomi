import type {
  FixRunNotifyEvent,
  FixRunNotifyEvents,
  FixRunState,
  FixRunWarning,
} from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'

/**
 * What a fix run notification announces. `pr_opened` through `failed` follow the run's state;
 * `warning:<code>` is one per warning code of the run (`watch_paths_skip`, `deploy_not_seen`).
 */
export type FixRunEventKey =
  | 'pr_opened'
  | 'checks_failing'
  | 'verified'
  | 'not_cleared'
  | 'failed'
  | `warning:${FixRunWarning['code']}`

/** The setting that switches each event on or off. */
export function switchOf(event: FixRunEventKey): FixRunNotifyEvent {
  switch (event) {
    case 'pr_opened':
      return 'prOpened'
    case 'checks_failing':
      return 'checksFailing'
    case 'verified':
      return 'verified'
    case 'not_cleared':
      return 'notCleared'
    case 'failed':
      return 'failed'
    default:
      return 'warnings'
  }
}

/**
 * States where the PR is the news. A run first seen after it merged (a restart, a late poll)
 * skips straight past them, and announcing a PR that is already merged would be stale.
 */
const PR_STATES: ReadonlySet<FixRunState> = new Set([
  'pr_open',
  'checks_pending',
  'checks_passing',
  'checks_failing',
  'checks_none',
])

/** Events a run's current row calls for, whatever was sent before. */
export function eventsOf(run: FixRunRow): FixRunEventKey[] {
  const events: FixRunEventKey[] = []
  if (run.prUrl !== null && PR_STATES.has(run.state)) events.push('pr_opened')
  if (run.state === 'checks_failing') events.push('checks_failing')
  if (run.state === 'verified') events.push('verified')
  if (run.state === 'not_cleared') events.push('not_cleared')
  // A cancelled workflow is a person's choice, a superseded run is replaced: neither is news.
  if (run.state === 'failed' || run.state === 'lost') events.push('failed')
  for (const code of new Set(run.warnings.map((w) => w.code))) events.push(`warning:${code}`)
  return events
}

/** True when the event's switch is on. */
export function isEnabled(event: FixRunEventKey, switches: FixRunNotifyEvents): boolean {
  return switches[switchOf(event)]
}
