import type {
  AdvisorySeverity,
  BlindSpotType,
  DeploymentReach,
  FindingKind,
  FindingScope,
  FindingTier,
  GuardCheck,
  GuardLevel,
  Severity,
} from '@hinomi/shared'

/**
 * How far a finding reaches: a public deployment, only internal ones, a released desktop app
 * (the latest release tag of a repo nothing deploys), or nothing.
 */
export type ExposureReach = 'public' | 'internal' | 'released' | 'none'

export interface ExposureInput {
  /** Coverage notes rank below every advisory (see rankExposure). */
  kind: FindingKind
  /** Advisory severity. Ignored for blind spots, which rank by their type. */
  severity?: AdvisorySeverity | null
  /** Blind spot type, required when kind is `blind_spot`. */
  blindSpotType?: BlindSpotType | null
  /** Guard check and level, required when kind is `guard`. */
  guardCheck?: GuardCheck | null
  guardLevel?: GuardLevel | null
  scope: FindingScope
  reach: ExposureReach
  /** CVSS base score, only used to order findings that tie on every factor. */
  cvssScore?: number | null
  /** GitHub's alert is stale: the lockfile already resolves only patched versions. */
  patchedInLockfile?: boolean
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
/** A released desktop app weighs like an internal deployment (decision Q18). */
const REACH_WEIGHT: Record<ExposureReach, number> = {
  public: 2,
  internal: 1,
  released: 1,
  none: 0,
}

/** Reaches that run in a deployment. A released app is in users' hands, not deployed. */
const isDeployedReach = (reach: ExposureReach) => reach === 'public' || reach === 'internal'

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

/**
 * How severe each guard level counts, like BLIND_SPOT_SEVERITY. A check only produces the levels
 * its copy lists (GUARD_COPY); the others are here so the table is total. `unknown` never ranks
 * by severity: it ranks like a coverage note.
 */
export const GUARD_SEVERITY: Record<GuardCheck, Record<'warn' | 'fail', Severity>> = {
  docker_socket: { fail: 'critical', warn: 'high' },
  root_user: { fail: 'high', warn: 'moderate' },
  shared_network: { fail: 'high', warn: 'moderate' },
  runtime_support: { fail: 'high', warn: 'moderate' },
  framework_support: { fail: 'high', warn: 'moderate' },
  watch_paths_skip: { fail: 'moderate', warn: 'moderate' },
  runtime_pins_disagree: { fail: 'low', warn: 'low' },
  action_runtime: { fail: 'moderate', warn: 'low' },
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
  if (input.kind === 'coverage_note') return rankCoverageNote(input.reach)
  if (input.kind === 'guard') return rankGuard(input)
  if (input.kind === 'advisory' && input.patchedInLockfile) return rankPatched(input)
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
      deployed: isDeployedReach(input.reach),
      public: input.reach === 'public',
    },
    unscored,
  }
}

/**
 * A guard finding: `reach * 10 + running * 5 + severity`, with no CVSS part. A guard is about
 * the shipped app, so "runtime" means it runs: a stopped deployment (reach none) keeps its
 * finding, ranked low. `unknown` (the source cannot tell) ranks like a coverage note.
 */
function rankGuard(input: ExposureInput): ExposureRank {
  if (!input.guardCheck || !input.guardLevel) {
    throw new Error('A guard finding needs its check and level to be ranked')
  }
  if (input.guardLevel === 'unknown') return rankCoverageNote(input.reach)
  const severity = GUARD_SEVERITY[input.guardCheck][input.guardLevel]
  const running = isDeployedReach(input.reach)
  const rank = REACH_WEIGHT[input.reach] * 10 + (running ? 5 : 0) + SEVERITY_WEIGHT[severity]
  return {
    rank,
    factors: { severity, runtime: running, deployed: running, public: input.reach === 'public' },
    unscored: false,
  }
}

/**
 * An advisory GitHub still reports although the lockfile is patched: nothing to
 * fix, so it ranks below every open advisory (rank at least 1) but above coverage
 * notes, deployed before not deployed. Severity and scope still show in the factors.
 */
function rankPatched(input: ExposureInput): ExposureRank {
  const { severity, unscored } = effectiveSeverity(input)
  return {
    rank: 0.5 + REACH_WEIGHT[input.reach] / 100,
    factors: {
      severity,
      runtime: input.scope !== 'dev',
      deployed: isDeployedReach(input.reach),
      public: input.reach === 'public',
    },
    unscored,
  }
}

/**
 * A coverage note is something Hinomi knows it does not check yet, not a
 * vulnerability: it ranks low, below every advisory (whose rank is at least 1),
 * public before internal. Its factors still tell where it runs.
 */
function rankCoverageNote(reach: ExposureReach): ExposureRank {
  return {
    rank: REACH_WEIGHT[reach] / 10,
    factors: {
      severity: 'low',
      runtime: true,
      deployed: isDeployedReach(reach),
      public: reach === 'public',
    },
    unscored: false,
  }
}

/** The fields of a deployment that decide its reach. */
export interface ReachInput {
  reach: DeploymentReach
  /** Raw status of the source, for example `running:healthy` or `exited:unhealthy`. */
  status?: string | null
}

const STOPPED_STATES = ['exited', 'stopped']

/**
 * True when the source says the deployment is not running: `exited` or
 * `stopped`, with or without a health suffix. Restarting, degraded, starting
 * and unknown statuses count as running, so a stopped app is never assumed
 * for anything unclear.
 */
export function isStoppedStatus(status: string | null | undefined): boolean {
  if (!status) return false
  const state = status.split(':')[0]!.trim().toLowerCase()
  return STOPPED_STATES.includes(state)
}

/** Deployments that are not stopped. */
export function runningDeployments<T extends ReachInput>(deployments: readonly T[]): T[] {
  return deployments.filter((d) => !isStoppedStatus(d.status))
}

/** Deployed somewhere, but every deployment is stopped: ranks as not deployed, keeps a badge. */
export function allStopped(deployments: readonly ReachInput[]): boolean {
  return deployments.length > 0 && runningDeployments(deployments).length === 0
}

/**
 * Widest reach of a set of deployments. Stopped deployments are ignored, so
 * an app that is down reaches nothing. A deployment whose reach is unknown
 * counts as public, to be safe.
 */
export function reachOf(deployments: readonly ReachInput[]): ExposureReach {
  const running = runningDeployments(deployments)
  if (running.length === 0) return 'none'
  return running.some((d) => d.reach !== 'internal') ? 'public' : 'internal'
}

/**
 * Display tier of a ranked finding (see FINDING_TIERS in the shared contract). Guards take the
 * reach tiers like advisories (decision Q2), except `unknown`, which goes to `coverage`.
 */
export function tierOf(ranked: {
  kind: FindingKind
  factors: ExposureFactors
  patchedInLockfile?: boolean
  reach?: ExposureReach
  guardLevel?: GuardLevel | null
}): FindingTier {
  if (ranked.kind === 'blind_spot') return 'blind_spot'
  if (ranked.kind === 'coverage_note') return 'coverage'
  if (ranked.kind === 'guard' && ranked.guardLevel === 'unknown') return 'coverage'
  if (ranked.patchedInLockfile) return 'patched'
  const { factors } = ranked
  // Dev dependencies are not shipped in an installer.
  if (ranked.reach === 'released') return factors.runtime ? 'released' : 'dev'
  if (!factors.deployed) return 'not_deployed'
  if (!factors.runtime) return 'dev'
  if (!factors.public) return 'internal'
  return factors.severity === 'critical' || factors.severity === 'high' ? 'exposed' : 'public_low'
}

/** Descending by rank; stable for equal ranks. */
export function compareByRank(a: { rank: number }, b: { rank: number }): number {
  return b.rank - a.rank
}
