import type { FindingRow } from '../../db/schema.js'
import type { Repositories } from '../../repository/index.js'
import { guardFindingKey } from '../../repository/index.js'
import type { FindingChange } from '../apply.js'
import type { DeploymentIndex } from '../deployments.js'
import { isTurnedOff } from '../overrides.js'
import { markFixed } from '../state.js'
import type { GuardOutcome } from './types.js'

// `archived_deployed` was a repo blind spot before it became a guard check with the same id. An
// open blind spot row from that time hands over to the guard rows of the deployments that run the
// repo. It closes once the guard has an outcome for every one of them: until then it stays open,
// so a scan that could not read GitHub never turns an archived repo into a silent pass.

/** Resolution data of a blind spot row the guard took over. The digest does not list it. */
export const MOVED_TO_GUARD = { reason: 'moved_to_guard', check: 'archived_deployed' } as const

/** Event of a guard row that took the snooze or acceptance of the blind spot row it replaced. */
export const CARRIED_OVER_EVENT = 'carried_over'

/** True for the `resolved` data of a blind spot row the guard took over. */
export function isMovedToGuard(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === MOVED_TO_GUARD.reason
  )
}

const ANNOUNCED: ReadonlySet<FindingChange['change']> = new Set(['opened', 'reopened', 'escalated'])
const OPENED: ReadonlySet<FindingChange['change']> = new Set(['opened', 'reopened'])

/**
 * A snooze, or an acceptance with an end date, the user set on the blind spot row. An acceptance
 * by a check override is left out: the override carries over by itself (same check id).
 */
function carriedState(row: FindingRow): boolean {
  return (
    (row.state === 'snoozed' || row.state === 'accepted') &&
    row.stateUntil !== null &&
    !isTurnedOff(row)
  )
}

/** Repo ids whose entry makes the outcome fail or unknown (turned off entries left out). */
function badRepoIds(outcome: GuardOutcome): number[] {
  if (outcome.level === 'pass' || outcome.evidence?.check !== 'archived_deployed') return []
  return outcome.evidence.repos
    .filter((r) => r.result !== 'pass' && !r.turnedOff)
    .map((r) => r.repoId)
}

/**
 * Hands open `archived_deployed` blind spot rows over to the guard, in two steps.
 *
 * Carry over, per deployment, in the scan its guard row opens: when every repo that makes the
 * row fail or unknown has an old row the user snoozed or accepted until a date, the guard row
 * takes that state (the earliest end, with its reason; event `carried_over`) and its opening is
 * not announced. Any bad repo without such a row leaves the guard row open and announced.
 *
 * Close: a row whose every deployment got an outcome this scan resolves with MOVED_TO_GUARD (no
 * change is reported: nothing was fixed); until then it stays open. A row whose repo nothing
 * deploys any more resolves as before (`not_deployed`).
 *
 * Returns `changes` without the announcements of the guard rows that took a state.
 */
export function handOverArchivedBlindSpots(
  repositories: Repositories,
  outcomes: readonly GuardOutcome[],
  index: DeploymentIndex,
  now: Date,
  changes: FindingChange[],
): FindingChange[] {
  const { findings } = repositories
  const rows = findings
    .list({ kind: 'blind_spot' })
    .filter(
      (f) => f.blindSpotType === 'archived_deployed' && f.state !== 'fixed' && f.repoId !== null,
    )
  if (rows.length === 0) return changes
  const byRepo = new Map(rows.map((row) => [row.repoId!, row]))
  const decided = new Map<number, GuardOutcome>()
  for (const outcome of outcomes) {
    if (outcome.check === 'archived_deployed' && 'deploymentId' in outcome.subject) {
      decided.set(outcome.subject.deploymentId, outcome)
    }
  }
  const opened = new Set(changes.filter((c) => OPENED.has(c.change)).map((c) => c.findingId))
  const silenced = new Set<number>()
  const out = [...changes]
  repositories.db.transaction(() => {
    for (const [deploymentId, outcome] of decided) {
      const bad = badRepoIds(outcome)
      if (bad.length === 0) continue
      const guard = findings.getByKey(guardFindingKey('archived_deployed', { deploymentId }))
      if (!guard || !opened.has(guard.id) || guard.state !== 'open') continue
      const sources = bad.map((repoId) => byRepo.get(repoId))
      if (!sources.every((row): row is FindingRow => row !== undefined && carriedState(row))) {
        continue
      }
      const first = [...sources].sort(
        (a, b) => a.stateUntil!.getTime() - b.stateUntil!.getTime(),
      )[0]!
      findings.changeState(
        guard.id,
        {
          state: first.state,
          reason: first.stateReason,
          until: first.stateUntil,
          actor: 'system',
          eventType: CARRIED_OVER_EVENT,
          data: { fromFindingIds: sources.map((row) => row.id) },
        },
        now,
      )
      silenced.add(guard.id)
    }
    for (const row of rows) {
      const deployments = index.byRepo.get(row.repoId!) ?? []
      if (deployments.length === 0) {
        if (markFixed(findings, row, now, { reason: 'not_deployed' })) {
          out.push({ findingId: row.id, change: 'fixed' })
        }
        continue
      }
      if (deployments.every((d) => decided.has(d.id))) markFixed(findings, row, now, MOVED_TO_GUARD)
    }
  })
  return out.filter((c) => !(silenced.has(c.findingId) && ANNOUNCED.has(c.change)))
}
