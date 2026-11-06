import type {
  AdvisorySummary,
  DeploymentRef,
  FindingDetail,
  FindingEvent,
  FindingListItem,
  FindingTier,
  RepoRef,
  ScanRun,
  SourceDto,
} from '@hinomi/shared'
import type {
  AdvisoryRow,
  DeploymentRow,
  FindingEventRow,
  RepoRow,
  ScanRunRow,
} from '../db/schema.js'
import type { Source } from '../repository/index.js'
import type { RankedFinding } from '../scan/index.js'

// Rows to API shapes. Dates become ISO strings; nothing secret is ever copied.

const iso = (date: Date) => date.toISOString()
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null)

export function toRepoRef(repo: RepoRow): RepoRef {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: `${repo.owner}/${repo.name}`,
    archived: repo.archived,
    alertsEnabled: repo.alertsEnabled,
    lastScannedAt: isoOrNull(repo.lastScannedAt),
  }
}

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

/** Display tier of a ranked finding (see FINDING_TIERS in the shared contract). */
export function tierOf(ranked: Pick<RankedFinding, 'kind' | 'factors'>): FindingTier {
  if (ranked.kind === 'blind_spot') return 'blind_spot'
  const { factors } = ranked
  if (!factors.deployed) return 'not_deployed'
  if (!factors.runtime) return 'dev'
  if (!factors.public) return 'internal'
  return factors.severity === 'critical' || factors.severity === 'high' ? 'exposed' : 'public_low'
}

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
    state: finding.state,
    stateReason: finding.stateReason,
    stateUntil: isoOrNull(finding.stateUntil),
    scope: finding.scope,
    sources: finding.reportedBy,
    blindSpotType: finding.blindSpotType,
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
    actor: event.actor,
    at: iso(event.at),
  }
}

export function toFindingDetail(ranked: RankedFinding, events: FindingEventRow[]): FindingDetail {
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
        }
      : null,
    versions: {
      installed: finding.installedVersion,
      firstPatched: advisory?.firstPatchedVersion ?? null,
      vulnerableRanges: advisory?.vulnerableRanges ?? [],
    },
    dependency: { scope: finding.scope, manifestPaths: finding.manifestPaths },
    history: events.map(toFindingEvent),
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
