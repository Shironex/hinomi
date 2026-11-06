import type { BlindSpotType, Reporter, Severity } from '@hinomi/shared'
import type { RankedFinding } from '../scan/index.js'

/** What happened to a finding, as far as a notification is concerned. */
export type ItemEvent = 'opened' | 'reopened' | 'fixed' | 'resolved' | 'expired'

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

export const BLIND_SPOT_LABELS: Record<BlindSpotType, string> = {
  alerts_disabled: 'Dependabot alerts are off',
  alerts_unknown: 'Dependabot alerts status unknown',
  archived_deployed: 'Archived repository is still deployed',
  no_repo_mapping: 'Deployment has no repository',
  lockfile_missing: 'No lockfile found',
  lockfile_unparseable: 'Lockfile could not be read',
}

/** One finding change, flattened to what a message needs. Source of both the Discord and the JSON payload. */
export interface NotificationItem {
  event: ItemEvent
  findingId: number
  kind: 'advisory' | 'blind_spot'
  severity: Severity
  title: string
  blindSpotType: BlindSpotType | null
  /** `owner/name`, null when the finding has no repository. */
  repo: string | null
  package: string | null
  ecosystem: string | null
  /** Advisory id (GHSA or the OSV id). */
  advisory: string | null
  cves: string[]
  summary: string | null
  installedVersion: string | null
  fixedIn: string | null
  deployments: { name: string; reach: string; server: string | null }[]
  sources: Reporter[]
  /** Link back to the finding in Hinomi, null without a public base URL. */
  url: string | null
}

export function findingUrl(baseUrl: string | null, findingId: number): string | null {
  return baseUrl ? `${baseUrl}/finding/${findingId}` : null
}

export function buildItem(
  ranked: RankedFinding,
  event: ItemEvent,
  baseUrl: string | null,
): NotificationItem {
  const { finding, advisory, repo } = ranked
  const isBlindSpot = ranked.kind === 'blind_spot'
  const blindSpotType = finding.blindSpotType
  const title = isBlindSpot
    ? BLIND_SPOT_LABELS[blindSpotType ?? 'no_repo_mapping']
    : (advisory?.packageName ?? 'unknown package')
  return {
    event,
    findingId: finding.id,
    kind: ranked.kind,
    severity: ranked.factors.severity,
    title,
    blindSpotType,
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    package: advisory?.packageName ?? null,
    ecosystem: advisory?.ecosystem ?? null,
    advisory: advisory ? (advisory.ghsaId ?? advisory.advisoryKey) : null,
    cves: advisory?.cveIds ?? [],
    summary: advisory?.summary ?? null,
    installedVersion: finding.installedVersion,
    fixedIn: advisory?.firstPatchedVersion ?? null,
    deployments: ranked.deployments.map((d) => ({
      name: d.name,
      reach: d.reach,
      server: d.server,
    })),
    sources: finding.reportedBy,
    url: findingUrl(baseUrl, finding.id),
  }
}

/** True when the channel wants this severity or worse. */
export function meetsMinimum(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[minimum]
}

export function compareItems(a: NotificationItem, b: NotificationItem): number {
  return SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.findingId - b.findingId
}
