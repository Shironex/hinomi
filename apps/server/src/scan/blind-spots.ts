import type { BlindSpotType } from '@hinomi/shared'
import type { Repositories } from '../repository/index.js'
import { blindSpotFindingKey } from '../repository/index.js'
import type { FindingChange } from './apply.js'
import type { RepoScan } from './collect.js'
import { needsRepoMapping, type DeploymentIndex } from './deployments.js'
import { markFixed, reopenIfFixed } from './state.js'

/** Blind spots about a repo, as opposed to `no_repo_mapping`, which is about a deployment. */
export const REPO_BLIND_SPOTS = [
  'alerts_disabled',
  'alerts_unknown',
  'archived_deployed',
  'lockfile_missing',
  'lockfile_unparseable',
] as const satisfies readonly BlindSpotType[]

type Subject = { repoId: number } | { deploymentId: number }

/** `present` is null when this scan could not tell (a source errored): the finding is left alone. */
export interface BlindSpotCheck {
  type: BlindSpotType
  subject: Subject
  present: boolean | null
  data?: Record<string, unknown>
  /** Written on the `resolved` event when this check clears the finding. */
  resolvedData?: Record<string, unknown>
}

/** Resolution note for a lockfile blind spot that is no longer checked because OSV is off. */
const NOT_CHECKED = { checked: false, reason: 'osv_disabled' }

/**
 * Blind spot checks for one repo. Only deployed repos have blind spots, so a
 * repo that is not deployed (anymore) clears all of them.
 */
export function repoBlindSpotChecks(
  repoId: number,
  deployed: boolean,
  scan: RepoScan | undefined,
): BlindSpotCheck[] {
  const subject = { repoId }
  if (!deployed) return REPO_BLIND_SPOTS.map((type) => ({ type, subject, present: false }))
  const health = scan?.health.status === 'ok' ? scan.health.value : null
  const osv = scan?.osv.status === 'ok' ? scan.osv.value : null
  // OSV switched off: nothing reads lockfiles, so these resolve as "not checked" instead of going stale.
  const osvOff = scan?.osv.status === 'skipped'
  const lockfile = (type: BlindSpotType, present: boolean | null): BlindSpotCheck => ({
    type,
    subject,
    present: osvOff ? false : present,
    ...(osvOff && { resolvedData: NOT_CHECKED }),
  })
  return [
    { type: 'alerts_disabled', subject, present: health ? health.alertsEnabled === false : null },
    { type: 'alerts_unknown', subject, present: health ? health.alertsEnabled === null : null },
    { type: 'archived_deployed', subject, present: health ? health.archived : null },
    lockfile(
      'lockfile_missing',
      osv ? osv.lockfiles.length === 0 && osv.unparseable.length === 0 : null,
    ),
    {
      ...lockfile('lockfile_unparseable', osv ? osv.unparseable.length > 0 : null),
      ...(osv && osv.unparseable.length > 0 && { data: { lockfiles: osv.unparseable } }),
    },
  ]
}

export function deploymentBlindSpotChecks(index: DeploymentIndex): BlindSpotCheck[] {
  const unmapped = new Set(index.unmapped.map((d) => d.id))
  return index.deployments.map((deployment) => ({
    type: 'no_repo_mapping',
    subject: { deploymentId: deployment.id },
    present: needsRepoMapping(deployment) && unmapped.has(deployment.id),
  }))
}

function applyCheck(
  repositories: Repositories,
  check: BlindSpotCheck,
  now: Date,
  changes: FindingChange[],
): void {
  const { findings } = repositories
  if (check.present === null) return
  if (check.present) {
    const { finding, created } = findings.observe(
      { kind: 'blind_spot', blindSpotType: check.type, ...check.subject },
      now,
    )
    if (created) {
      if (check.data) {
        findings.addEvent({
          findingId: finding.id,
          type: 'details',
          actor: 'system',
          data: check.data,
          at: now,
        })
      }
      changes.push({ findingId: finding.id, change: 'opened' })
    } else if (reopenIfFixed(findings, finding, now)) {
      changes.push({ findingId: finding.id, change: 'reopened' })
    }
    return
  }
  const existing = findings.getByKey(blindSpotFindingKey(check.type, check.subject))
  if (existing && markFixed(findings, existing, now, check.resolvedData)) {
    changes.push({ findingId: existing.id, change: 'fixed' })
  }
}

/**
 * Opens, reopens and resolves blind spots. Repos checked are the ones scanned
 * this run plus every repo that already has a blind spot (so one that is no
 * longer deployed resolves).
 */
export function applyBlindSpots(
  repositories: Repositories,
  index: DeploymentIndex,
  scans: ReadonlyMap<number, RepoScan>,
  now: Date,
): FindingChange[] {
  return repositories.db.transaction(() => {
    const changes: FindingChange[] = []
    const repoIds = new Set(scans.keys())
    for (const finding of repositories.findings.list({ kind: 'blind_spot' })) {
      if (finding.repoId !== null) repoIds.add(finding.repoId)
    }
    const checks = [
      ...[...repoIds].flatMap((repoId) =>
        repoBlindSpotChecks(repoId, index.byRepo.has(repoId), scans.get(repoId)),
      ),
      ...deploymentBlindSpotChecks(index),
    ]
    for (const check of checks) applyCheck(repositories, check, now, changes)
    return changes
  })
}
