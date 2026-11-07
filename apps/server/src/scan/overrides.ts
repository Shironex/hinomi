import { OVERRIDABLE_CHECKS, type OverridableCheck } from '@hinomi/shared'
import type { CheckOverrideRow, FindingRow } from '../db/schema.js'
import type { FindingsRepository, OverrideSubject, Repositories } from '../repository/index.js'
import type { FindingChange } from './apply.js'
import { indexDeployments, type DeploymentIndex } from './deployments.js'

// Check overrides (decisions Q3 to Q5): a check turned off for a deployment or a repo keeps
// running, and its finding is stored as `accepted` with the override's reason and a `turned_off`
// event. Rank, never hide.

/** The override that turns a check off for a subject, and whether it was set on a deployment or a repo. */
export interface CoveringOverride {
  override: CheckOverrideRow
  scope: 'deployment' | 'repo'
}

export interface OverrideIndex {
  /**
   * The override covering `check` on a subject, or null. A deployment is covered by an override
   * on itself, else by one on any repo it runs. A repo is covered by an override on itself, else
   * when every deployment that runs it has the check turned off (so `archived_deployed`, a repo
   * blind spot, can be turned off from the deployment).
   */
  covering(check: OverridableCheck, subject: OverrideSubject): CoveringOverride | null
}

const KNOWN_CHECKS: ReadonlySet<string> = new Set(OVERRIDABLE_CHECKS)

export function indexOverrides(
  rows: readonly CheckOverrideRow[],
  deployments: DeploymentIndex,
): OverrideIndex {
  const byDeployment = new Map<string, CheckOverrideRow>()
  const byRepo = new Map<string, CheckOverrideRow>()
  for (const row of rows) {
    if (!KNOWN_CHECKS.has(row.check)) continue
    if (row.deploymentId !== null) byDeployment.set(`${row.check}:${row.deploymentId}`, row)
    else if (row.repoId !== null) byRepo.set(`${row.check}:${row.repoId}`, row)
  }
  const reposOf = new Map<number, number[]>()
  for (const [repoId, list] of deployments.byRepo) {
    for (const d of list) reposOf.set(d.id, [...(reposOf.get(d.id) ?? []), repoId])
  }

  return {
    covering(check, subject) {
      if ('deploymentId' in subject) {
        const own = byDeployment.get(`${check}:${subject.deploymentId}`)
        if (own) return { override: own, scope: 'deployment' }
        for (const repoId of reposOf.get(subject.deploymentId) ?? []) {
          const repo = byRepo.get(`${check}:${repoId}`)
          if (repo) return { override: repo, scope: 'repo' }
        }
        return null
      }
      const own = byRepo.get(`${check}:${subject.repoId}`)
      if (own) return { override: own, scope: 'repo' }
      const running = deployments.byRepo.get(subject.repoId) ?? []
      const each = running.map((d) => byDeployment.get(`${check}:${d.id}`))
      const first = each[0]
      if (first && each.every((row) => row !== undefined)) {
        return { override: first, scope: 'deployment' }
      }
      return null
    },
  }
}

/** Reads every override and the deployment index. */
export function loadOverrideIndex(
  repositories: Repositories,
  deployments: DeploymentIndex = indexDeployments(repositories),
): OverrideIndex {
  return indexOverrides(repositories.checkOverrides.list(), deployments)
}

/**
 * True when the finding was accepted by a check override. A user's acceptance always has an
 * expiry (or waits for a new advisory, which only advisories can), so an acceptance with neither
 * comes from an override. Such an acceptance never expires.
 */
export function isTurnedOff(
  finding: Pick<FindingRow, 'state' | 'stateUntil' | 'stateUntilNewAdvisory'>,
): boolean {
  return (
    finding.state === 'accepted' && finding.stateUntil === null && !finding.stateUntilNewAdvisory
  )
}

/** The check of a guard or blind spot finding, null for kinds that cannot be turned off. */
export function overridableCheckOf(finding: FindingRow): OverridableCheck | null {
  if (finding.kind === 'guard') return finding.guardCheck
  if (finding.kind === 'blind_spot') return finding.blindSpotType
  return null
}

/** The subject of a guard or blind spot finding. */
export function subjectOf(finding: FindingRow): OverrideSubject | null {
  if (finding.deploymentId !== null) return { deploymentId: finding.deploymentId }
  if (finding.repoId !== null) return { repoId: finding.repoId }
  return null
}

/**
 * Brings a finding in line with its override: covered and not yet turned off moves it to
 * `accepted` with the override's reason (event `turned_off`, actor user, since a person set the
 * override); a changed reason is written the same way; turned off with no override left reopens
 * it (event `reopened`, reason `override_removed`). Fixed findings are left alone.
 */
export function reconcileOverride(
  findings: FindingsRepository,
  finding: FindingRow,
  covering: CoveringOverride | null,
  now: Date,
): FindingChange['change'] | null {
  if (finding.state === 'fixed') return null
  const off = isTurnedOff(finding)
  if (covering) {
    if (off && finding.stateReason === covering.override.reason) return null
    findings.changeState(
      finding.id,
      {
        state: 'accepted',
        reason: covering.override.reason,
        until: null,
        actor: 'user',
        eventType: 'turned_off',
        data: { overrideId: covering.override.id, scope: covering.scope },
      },
      now,
    )
    return off ? null : 'turned_off'
  }
  if (!off) return null
  findings.changeState(
    finding.id,
    { state: 'open', actor: 'system', eventType: 'reopened', data: { reason: 'override_removed' } },
    now,
  )
  return 'reopened'
}

/**
 * Applies the current overrides to every guard and blind spot finding that is not fixed, right
 * away (after an override is created, edited or removed), so the UI does not wait for a scan.
 */
export function applyOverridesNow(repositories: Repositories, now: Date): FindingChange[] {
  return repositories.db.transaction(() => {
    const overrides = loadOverrideIndex(repositories)
    const changes: FindingChange[] = []
    const candidates = [
      ...repositories.findings.list({ kind: 'guard' }),
      ...repositories.findings.list({ kind: 'blind_spot' }),
    ]
    for (const finding of candidates) {
      const check = overridableCheckOf(finding)
      const subject = subjectOf(finding)
      if (!check || !subject) continue
      const change = reconcileOverride(
        repositories.findings,
        finding,
        overrides.covering(check, subject),
        now,
      )
      if (change) changes.push({ findingId: finding.id, change })
    }
    return changes
  })
}
