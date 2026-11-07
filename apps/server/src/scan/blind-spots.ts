import type { BlindSpotType, ImageScanMode } from '@hinomi/shared'
import type { Repositories } from '../repository/index.js'
import { blindSpotFindingKey, coverageNoteFindingKey } from '../repository/index.js'
import type { FindingChange } from './apply.js'
import type { RepoScan } from './collect.js'
import { isImageOnly, needsRepoMapping, type DeploymentIndex } from './deployments.js'
import { coveredByImageScan, type ImageCoverage } from './image-scan.js'
import { loadOverrideIndex, reconcileOverride, type OverrideIndex } from './overrides.js'
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
 * repo that is not deployed (anymore) clears all of them. Without a GitHub
 * source nothing can say whether alerts are on or a lockfile exists (private
 * repos read as empty), so those checks are left alone until GitHub is connected.
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
  // Health is only skipped when no GitHub source is connected (see collectGithub).
  const githubMissing = scan?.health.status === 'skipped'
  const lockfile = (type: BlindSpotType, present: boolean | null): BlindSpotCheck => ({
    type,
    subject,
    present: osvOff ? false : githubMissing ? null : present,
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

/** Resolution note of a `no_repo_mapping` blind spot whose deployment turned out to have no git source. */
const RECLASSIFIED_IMAGE_ONLY = { reason: 'reclassified', as: 'image_only' }

export function deploymentBlindSpotChecks(index: DeploymentIndex): BlindSpotCheck[] {
  const unmapped = new Set(index.unmapped.map((d) => d.id))
  return index.deployments.map((deployment) => ({
    type: 'no_repo_mapping',
    subject: { deploymentId: deployment.id },
    present: needsRepoMapping(deployment) && unmapped.has(deployment.id),
    ...(isImageOnly(deployment) &&
      unmapped.has(deployment.id) && { resolvedData: RECLASSIFIED_IMAGE_ONLY }),
  }))
}

/** What the image scan said this scan, for the `image_only` notes. */
export interface ImageScanCoverage {
  mode: ImageScanMode
  coverage: ImageCoverage
}

/**
 * Opens and resolves `image_only` coverage notes: one per deployment with no
 * git source and no manual repo mapping. A mapping or a git source clears it,
 * and so does the image scan when it covers the deployment. When the image scan
 * could not tell this time, the note is left as it is.
 */
export function applyCoverageNotes(
  repositories: Repositories,
  index: DeploymentIndex,
  now: Date,
  imageScan?: ImageScanCoverage,
): FindingChange[] {
  const { findings } = repositories
  const unmapped = new Set(index.unmapped.map((d) => d.id))
  const changes: FindingChange[] = []
  for (const deployment of index.deployments) {
    const existing = findings.getByKey(coverageNoteFindingKey('image_only', deployment.id))
    if (isImageOnly(deployment) && unmapped.has(deployment.id)) {
      const covered = imageScan?.coverage.get(deployment.id)
      if (covered === null) continue
      if (covered) {
        if (existing && markFixed(findings, existing, now, coveredByImageScan(covered))) {
          changes.push({ findingId: existing.id, change: 'fixed' })
        }
        continue
      }
      const { finding, created } = findings.observe(
        { kind: 'coverage_note', coverageNoteType: 'image_only', deploymentId: deployment.id },
        now,
      )
      if (created) changes.push({ findingId: finding.id, change: 'opened' })
      else if (reopenIfFixed(findings, finding, now)) {
        changes.push({ findingId: finding.id, change: 'reopened' })
      }
      continue
    }
    if (existing && markFixed(findings, existing, now)) {
      changes.push({ findingId: existing.id, change: 'fixed' })
    }
  }
  return changes
}

function applyCheck(
  repositories: Repositories,
  check: BlindSpotCheck,
  overrides: OverrideIndex,
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
    const current = findings.get(finding.id)
    const change =
      current &&
      reconcileOverride(findings, current, overrides.covering(check.type, check.subject), now)
    if (change) changes.push({ findingId: finding.id, change })
    return
  }
  const existing = findings.getByKey(blindSpotFindingKey(check.type, check.subject))
  if (existing && markFixed(findings, existing, now, check.resolvedData)) {
    changes.push({ findingId: existing.id, change: 'fixed' })
  }
}

/**
 * Opens, reopens and resolves blind spots and coverage notes, and applies check overrides to
 * blind spots (Q5: `archived_deployed` can be turned off). Repos checked are the ones scanned
 * this run plus every repo that already has a blind spot (so one that is no
 * longer deployed resolves).
 */
export function applyBlindSpots(
  repositories: Repositories,
  index: DeploymentIndex,
  scans: ReadonlyMap<number, RepoScan>,
  now: Date,
  imageScan?: ImageScanCoverage,
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
    const overrides = loadOverrideIndex(repositories, index)
    for (const check of checks) applyCheck(repositories, check, overrides, now, changes)
    changes.push(...applyCoverageNotes(repositories, index, now, imageScan))
    return changes
  })
}
