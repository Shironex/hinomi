import type { FindingKind, FindingState, GuardCheck, GuardLevel } from '@hinomi/shared'
import type {
  AdvisoryRow,
  DeploymentRow,
  FindingEventRow,
  FindingRow,
  RepoRow,
} from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { countFindings, type FindingCounts } from './counts.js'
import { indexDeployments, type DeploymentIndex } from './deployments.js'
import {
  loadOverrideIndex,
  overridableCheckOf,
  subjectOf,
  type CoveringOverride,
} from './overrides.js'
import {
  allStopped,
  compareByRank,
  rankExposure,
  reachOf,
  type ExposureRank,
  type ExposureReach,
} from './rank.js'
import { currentTime } from '@hinomi/shared'

/** A finding joined with what it is about and ranked. What the API serves. */
export interface RankedFinding extends ExposureRank {
  kind: FindingKind
  state: FindingState
  stateUntil: Date | null
  reach: ExposureReach
  /** Guard findings: the check and the current level. Null for every other kind. */
  guardCheck: GuardCheck | null
  guardLevel: GuardLevel | null
  /** Every deployment it runs in is stopped: ranked as not deployed, kept visible with a badge. */
  stopped: boolean
  /** GitHub's alert is stale: every resolved version in the lockfile is patched. */
  patchedInLockfile: boolean
  finding: FindingRow
  advisory: AdvisoryRow | null
  repo: RepoRow | null
  /** Deployments the finding reaches: the repo's deployments, or the deployment itself. */
  deployments: DeploymentRow[]
  /** Guards and blind spots: the check override that turns it off, null when none does. */
  override: CoveringOverride | null
}

function deploymentsOf(finding: FindingRow, index: DeploymentIndex): DeploymentRow[] {
  if (finding.deploymentId !== null) {
    return index.deployments.filter((d) => d.id === finding.deploymentId)
  }
  return finding.repoId === null ? [] : (index.byRepo.get(finding.repoId) ?? [])
}

export function rankFinding(
  finding: FindingRow,
  advisory: AdvisoryRow | null,
  repo: RepoRow | null,
  deployments: DeploymentRow[],
): RankedFinding {
  const deployedReach = reachOf(deployments)
  // A desktop release finding on a repo nothing runs is in users' hands: the released tier.
  const reach = finding.releaseTag !== null && deployedReach === 'none' ? 'released' : deployedReach
  const rank = rankExposure({
    kind: finding.kind,
    severity: advisory?.severity ?? null,
    blindSpotType: finding.blindSpotType,
    guardCheck: finding.guardCheck,
    guardLevel: finding.guardLevel,
    scope: finding.scope,
    reach,
    cvssScore: advisory?.cvssScore ?? null,
    patchedInLockfile: finding.patchedInLockfile,
  })
  return {
    ...rank,
    kind: finding.kind,
    state: finding.state,
    stateUntil: finding.stateUntil,
    reach,
    guardCheck: finding.kind === 'guard' ? finding.guardCheck : null,
    guardLevel: finding.kind === 'guard' ? finding.guardLevel : null,
    stopped: allStopped(deployments),
    patchedInLockfile: finding.kind === 'advisory' && finding.patchedInLockfile,
    finding,
    advisory,
    repo,
    deployments,
    override: null,
  }
}

/** Memoised id lookup; a null id or a missing row gives null. */
function cachedLookup<T>(get: (id: number) => T | undefined): (id: number | null) => T | null {
  const cache = new Map<number, T | null>()
  return (id) => {
    if (id === null) return null
    if (!cache.has(id)) cache.set(id, get(id) ?? null)
    return cache.get(id) ?? null
  }
}

/**
 * Every finding, fixed ones included, ranked most urgent first. Nothing is
 * filtered out: views filter on `factors`, `state` and `kind`.
 */
export function listRankedFindings(repositories: Repositories): RankedFinding[] {
  const index = indexDeployments(repositories)
  const overrides = loadOverrideIndex(repositories, index)
  const advisoryOf = cachedLookup((id) => repositories.advisories.get(id))
  const repoOf = cachedLookup((id) => repositories.repos.get(id))
  const overrideOf = (finding: FindingRow): CoveringOverride | null => {
    const check = overridableCheckOf(finding)
    const subject = subjectOf(finding)
    return check && subject ? overrides.covering(check, subject) : null
  }
  return repositories.findings
    .list()
    .map((f) => ({
      ...rankFinding(f, advisoryOf(f.advisoryId), repoOf(f.repoId), deploymentsOf(f, index)),
      override: overrideOf(f),
    }))
    .sort((a, b) => compareByRank(a, b) || a.finding.id - b.finding.id)
}

/** Funnel and blind spot counts over the current findings. */
export function findingCounts(
  repositories: Repositories,
  now: Date = currentTime(),
): FindingCounts {
  return countFindings(listRankedFindings(repositories), now)
}

export interface FindingChangeSet {
  finding: FindingRow
  /** Events since the given time, oldest first (opened, reopened, fixed, resolved, ...). */
  events: FindingEventRow[]
}

/**
 * Findings that were created or changed at or after `since`, for
 * notifications. Pass the start of the previous scan run, or the last
 * time notifications went out.
 */
export function findingChangesSince(repositories: Repositories, since: Date): FindingChangeSet[] {
  const byFinding = new Map<number, FindingEventRow[]>()
  for (const event of repositories.findings.listEventsSince(since)) {
    const list = byFinding.get(event.findingId) ?? []
    list.push(event)
    byFinding.set(event.findingId, list)
  }
  const out: FindingChangeSet[] = []
  for (const [findingId, events] of byFinding) {
    const finding = repositories.findings.get(findingId)
    if (finding) out.push({ finding, events })
  }
  return out
}
