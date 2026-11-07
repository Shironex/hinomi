import {
  FINDING_TIERS,
  type AdvisorySummary,
  type DeploymentRef,
  type FindingDetail,
  type FindingEvent,
  type FindingListItem,
  type FindingNotification,
  type FindingTier,
  type FixItem,
  type FixPlan,
  type FixPlanRef,
  type ScanRun,
  type SeverityCounts,
  type SourceDto,
} from '@hinomi/shared'
import type {
  AdvisoryRow,
  DeploymentRow,
  FindingEventRow,
  FixPlanRow,
  ScanRunRow,
} from '../db/schema.js'
import type { Repositories, Source } from '../repository/index.js'
import { tierOf, toRepoRef, type Fix, type RankedFinding } from '../scan/index.js'

export { toRepoRef }

// Rows to API shapes. Dates become ISO strings; nothing secret is ever copied.

const iso = (date: Date) => date.toISOString()
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null)

export function toDeploymentRef(deployment: DeploymentRow): DeploymentRef {
  return {
    id: deployment.id,
    name: deployment.name,
    kind: deployment.kind,
    reach: deployment.reach,
    server: deployment.server,
    domains: deployment.domains,
  }
}

export function toAdvisorySummary(advisory: AdvisoryRow): AdvisorySummary {
  return {
    id: advisory.id,
    advisoryKey: advisory.advisoryKey,
    ghsaId: advisory.ghsaId,
    cveIds: advisory.cveIds,
    ecosystem: advisory.ecosystem,
    packageName: advisory.packageName,
    severity: advisory.severity,
    cvssScore: advisory.cvssScore,
    summary: advisory.summary,
    url: advisory.url,
    firstPatchedVersion: advisory.firstPatchedVersion,
  }
}

export { tierOf }

export function toFindingListItem(ranked: RankedFinding): FindingListItem {
  const { finding } = ranked
  return {
    id: finding.id,
    kind: finding.kind,
    rank: ranked.rank,
    tier: tierOf(ranked),
    factors: ranked.factors,
    unscored: ranked.unscored,
    stopped: ranked.stopped,
    patchedInLockfile: ranked.patchedInLockfile,
    state: finding.state,
    stateReason: finding.stateReason,
    stateUntil: isoOrNull(finding.stateUntil),
    stateUntilNewAdvisory: finding.stateUntilNewAdvisory,
    scope: finding.scope,
    sources: finding.reportedBy,
    blindSpotType: finding.blindSpotType,
    coverageNote: finding.kind === 'coverage_note' ? 'image_only' : null,
    advisory: ranked.advisory ? toAdvisorySummary(ranked.advisory) : null,
    installedVersion: finding.installedVersion,
    repo: ranked.repo ? toRepoRef(ranked.repo) : null,
    deployments: ranked.deployments.map(toDeploymentRef),
    firstSeenAt: iso(finding.firstSeenAt),
    lastSeenAt: iso(finding.lastSeenAt),
    fixedAt: isoOrNull(finding.fixedAt),
  }
}

export function toFindingEvent(event: FindingEventRow): FindingEvent {
  return {
    id: event.id,
    findingId: event.findingId,
    type: event.type,
    fromState: event.fromState,
    toState: event.toState,
    reason: event.reason,
    until: isoOrNull(event.until),
    untilNewAdvisory:
      (event.data as { untilNewAdvisory?: unknown } | null)?.untilNewAdvisory === true,
    actor: event.actor,
    at: iso(event.at),
  }
}

/** The dependency chain, and how much of it is known. */
function dependencyOf(finding: RankedFinding['finding']): FindingDetail['dependency'] {
  const path =
    finding.dependencyPath && finding.dependencyPath.length > 0 ? finding.dependencyPath : null
  return {
    scope: finding.scope,
    manifestPaths: finding.manifestPaths,
    path,
    pathSource: path ? 'lockfile' : finding.manifestPaths.length > 0 ? 'manifest' : 'package',
  }
}

export function toFindingDetail(
  ranked: RankedFinding,
  events: FindingEventRow[],
  notifications: FindingNotification[] = [],
  sameFixClears = 0,
  plan: FixPlanRef | null = null,
): FindingDetail {
  const { advisory, finding } = ranked
  return {
    ...toFindingListItem(ranked),
    advisory: advisory
      ? {
          ...toAdvisorySummary(advisory),
          aliases: advisory.aliases,
          cvssVector: advisory.cvssVector,
          vulnerableRanges: advisory.vulnerableRanges,
          publishedAt: isoOrNull(advisory.publishedAt),
          withdrawnAt: isoOrNull(advisory.withdrawnAt),
          description: advisory.description,
        }
      : null,
    versions: {
      installed: finding.installedVersion,
      firstPatched: advisory?.firstPatchedVersion ?? null,
      vulnerableRanges: advisory?.vulnerableRanges ?? [],
    },
    dependency: dependencyOf(finding),
    sameFixClears,
    plan,
    history: events.map(toFindingEvent),
    notifications,
  }
}

export function toScanRun(run: ScanRunRow): ScanRun {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: iso(run.startedAt),
    finishedAt: isoOrNull(run.finishedAt),
    durationMs: run.durationMs,
    sourceResults: run.sourceResults,
    findingsOpened: run.findingsOpened,
    findingsFixed: run.findingsFixed,
    error: run.error,
  }
}

/** The repository's Source already has no token field; only known fields are copied anyway. */
export function toSourceDto(source: Source): SourceDto {
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    baseUrl: source.baseUrl,
    enabled: source.enabled,
    auth: source.auth,
    appId: source.appId,
    installationId: source.installationId,
    hasToken: source.hasToken,
    lastOkAt: isoOrNull(source.lastOkAt),
    lastErrorAt: isoOrNull(source.lastErrorAt),
    lastError: source.lastError,
    createdAt: iso(source.createdAt),
    updatedAt: iso(source.updatedAt),
  }
}

/** A stored plan as a link with its summary. */
export function toFixPlanRef(row: FixPlanRow): FixPlanRef {
  return {
    repoId: row.repoId,
    scanRunId: row.scanRunId,
    createdAt: iso(row.createdAt),
    summary: row.plan.summary,
  }
}

/** Repo id to the link of its latest plan. */
export type PlanRefs = (repoId: number) => FixPlanRef | null

/** Links to every repo's latest plan, read once per request. */
export function latestPlanRefs(repositories: Repositories): PlanRefs {
  const refs = new Map(
    repositories.fixPlans.latestPerRepo().map((r) => [r.repoId, toFixPlanRef(r)]),
  )
  return (repoId) => refs.get(repoId) ?? null
}

/** A stored plan as served: the repo ref is read fresh, the rest is the stored contract. */
export function toFixPlan(row: FixPlanRow, repo: FixPlan['repo']): FixPlan {
  return { ...row.plan, repo }
}

/** A fix as the API serves it: counts by tier and severity, repos with their own target. */
export function toFixItem(fix: Fix, planOf: PlanRefs = () => null): FixItem {
  const byTier = Object.fromEntries(FINDING_TIERS.map((t) => [t, 0])) as Record<FindingTier, number>
  const bySeverity: SeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const finding of fix.findings) {
    byTier[tierOf(finding)]++
    bySeverity[finding.factors.severity]++
  }
  return {
    key: fix.key,
    ecosystem: fix.ecosystem,
    packageName: fix.packageName,
    target: fix.target,
    mixedTargets: fix.mixedTargets,
    findings: { total: fix.findings.length, byTier, bySeverity },
    findingIds: fix.findings.map((f) => f.finding.id),
    bestTier: fix.bestTier,
    exposedCritical: fix.exposedCritical,
    repos: fix.repos.map((r) => ({
      repo: toRepoRef(r.repo),
      target: r.target,
      findings: r.findings.length,
      plan: planOf(r.repo.id),
    })),
    apps: fix.apps.map(toDeploymentRef),
  }
}
