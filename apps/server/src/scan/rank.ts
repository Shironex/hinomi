import type {
  AdvisorySeverity,
  BlindSpotType,
  DeploymentReach,
  FindingKind,
  FindingScope,
  Severity,
} from '@hinomi/shared'

/** How far a finding reaches: a public deployment, only internal ones, or nothing deployed. */
export type ExposureReach = 'public' | 'internal' | 'none'

export interface ExposureInput {
  kind: FindingKind
  /** Advisory severity. Ignored for blind spots, which rank by their type. */
  severity?: AdvisorySeverity | null
  /** Blind spot type, required when kind is `blind_spot`. */
  blindSpotType?: BlindSpotType | null
  scope: FindingScope
  reach: ExposureReach
  /** CVSS base score, only used to order findings that tie on every factor. */
  cvssScore?: number | null
}

/** The four factors the UI shows next to a finding to explain its rank. */
export interface ExposureFactors {
  /** Effective severity: `unknown` ranks as moderate (see `unscored`). */
  severity: Severity
  /** Shipped at runtime. Unknown scope counts as runtime to be safe. */
  runtime: boolean
  /** Runs in at least one deployment. */
  deployed: boolean
  /** Reachable from the internet through at least one deployment. */
  public: boolean
}

export interface ExposureRank {
  /** Higher is more urgent. Sort descending. Never used to filter. */
  rank: number
  factors: ExposureFactors
  /** The advisory has no severity Hinomi could score (CVSS v4 only); ranked as moderate. */
  unscored: boolean
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1 }
const REACH_WEIGHT: Record<ExposureReach, number> = { public: 2, internal: 1, none: 0 }

/**
 * How severe each blind spot counts. Alerts switched off on a deployed repo
 * hides everything, so it ranks like a critical advisory.
 */
export const BLIND_SPOT_SEVERITY: Record<BlindSpotType, Severity> = {
  alerts_disabled: 'critical',
  alerts_unknown: 'high',
  archived_deployed: 'high',
  lockfile_missing: 'moderate',
  lockfile_unparseable: 'moderate',
  no_repo_mapping: 'moderate',
}

function effectiveSeverity(input: ExposureInput): { severity: Severity; unscored: boolean } {
  if (input.kind === 'blind_spot') {
    if (!input.blindSpotType) throw new Error('A blind spot needs its type to be ranked')
    return { severity: BLIND_SPOT_SEVERITY[input.blindSpotType], unscored: false }
  }
  const severity = input.severity ?? 'unknown'
  if (severity === 'unknown') return { severity: 'moderate', unscored: true }
  return { severity, unscored: false }
}

/**
 * Exposure rank of one finding. Tiers, most significant first:
 * reach (public > internal > not deployed), then runtime over dev, then
 * severity; the CVSS score only breaks ties. Blind spots are about the
 * shipped app, so they always count as runtime.
 *
 * rank = reach * 10 + runtime * 5 + severity (1..4) + cvss / 100
 */
export function rankExposure(input: ExposureInput): ExposureRank {
  const { severity, unscored } = effectiveSeverity(input)
  const runtime = input.kind === 'blind_spot' || input.scope !== 'dev'
  const cvss = input.kind === 'advisory' ? (input.cvssScore ?? 0) : 0
  const tieBreak = Math.min(Math.max(cvss, 0), 10) / 100
  const rank =
    REACH_WEIGHT[input.reach] * 10 + (runtime ? 5 : 0) + SEVERITY_WEIGHT[severity] + tieBreak
  return {
    rank: Math.round(rank * 1000) / 1000,
    factors: {
      severity,
      runtime,
      deployed: input.reach !== 'none',
      public: input.reach === 'public',
    },
    unscored,
  }
}

/**
 * Widest reach of a set of deployments. A deployment whose reach is unknown
 * counts as public, to be safe.
 */
export function reachOf(deployments: readonly { reach: DeploymentReach }[]): ExposureReach {
  if (deployments.length === 0) return 'none'
  return deployments.some((d) => d.reach !== 'internal') ? 'public' : 'internal'
}

/** Descending by rank; stable for equal ranks. */
export function compareByRank(a: { rank: number }, b: { rank: number }): number {
  return b.rank - a.rank
}
