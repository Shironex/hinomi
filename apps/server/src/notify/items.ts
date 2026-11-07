import {
  GUARD_CHECKS,
  GUARD_COPY,
  type BlindSpotType,
  type FindingKind,
  type GuardCheck,
  type GuardLevel,
  type Reporter,
  type Severity,
} from '@hinomi/shared'
import type { RankedFinding } from '../scan/index.js'

/**
 * What happened to a finding, as far as a notification is concerned. `escalated`: a guard's
 * level got worse (warn to fail, or a support window into end of life).
 */
export type ItemEvent = 'opened' | 'reopened' | 'fixed' | 'resolved' | 'expired' | 'escalated'

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

/** Message titles of guard checks: the same titles the app shows (GUARD_COPY). */
export const GUARD_LABELS = Object.fromEntries(
  GUARD_CHECKS.map((check) => [check, GUARD_COPY[check].title]),
) as Record<GuardCheck, string>

/** One finding change, flattened to what a message needs. Source of both the Discord and the JSON payload. */
export interface NotificationItem {
  event: ItemEvent
  findingId: number
  /** Never `coverage_note`: coverage notes are not sent (see the notifier). */
  kind: Exclude<FindingKind, 'coverage_note'>
  severity: Severity
  title: string
  blindSpotType: BlindSpotType | null
  /** Guard findings: the check and its level (never `unknown`, which is not sent). Null otherwise. */
  guardCheck: GuardCheck | null
  guardLevel: Exclude<GuardLevel, 'unknown'> | null
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

/**
 * A finding a message can carry: an advisory, a blind spot or a guard, never a coverage note and
 * never a guard at level `unknown` (the source cannot tell; that is not news).
 */
export type MessageFinding = RankedFinding & { kind: NotificationItem['kind'] }

export function isMessageFinding(ranked: RankedFinding): ranked is MessageFinding {
  if (ranked.kind === 'coverage_note') return false
  return ranked.kind !== 'guard' || (ranked.guardCheck !== null && ranked.guardLevel !== 'unknown')
}

/** Title and summary of a guard item, from the shared copy. */
function guardText(check: GuardCheck, level: GuardLevel | null) {
  const copy = GUARD_COPY[check]
  return { title: copy.title, summary: (level && copy.explanation[level]) ?? copy.question }
}

export function buildItem(
  ranked: MessageFinding,
  event: ItemEvent,
  baseUrl: string | null,
): NotificationItem {
  const { finding, advisory, repo } = ranked
  const isBlindSpot = ranked.kind === 'blind_spot'
  const blindSpotType = finding.blindSpotType
  const guard = ranked.guardCheck ? guardText(ranked.guardCheck, ranked.guardLevel) : null
  const title = guard
    ? guard.title
    : isBlindSpot
      ? BLIND_SPOT_LABELS[blindSpotType ?? 'no_repo_mapping']
      : (advisory?.packageName ?? 'unknown package')
  const level = ranked.guardLevel
  return {
    event,
    findingId: finding.id,
    kind: ranked.kind,
    severity: ranked.factors.severity,
    title,
    blindSpotType,
    guardCheck: ranked.guardCheck,
    guardLevel: level === null || level === 'unknown' ? null : level,
    repo: repo ? `${repo.owner}/${repo.name}` : null,
    package: advisory?.packageName ?? null,
    ecosystem: advisory?.ecosystem ?? null,
    advisory: advisory ? (advisory.ghsaId ?? advisory.advisoryKey) : null,
    cves: advisory?.cveIds ?? [],
    summary: guard?.summary ?? advisory?.summary ?? null,
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
