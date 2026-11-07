import {
  GUARD_CHECKS,
  GUARD_LEVELS,
  type FindingKind,
  type FindingState,
  type FunnelStep,
  type GuardCheck,
  type GuardLevel,
} from '@hinomi/shared'
import type { ExposureFactors } from './rank.js'

/** The fields of a ranked finding the counts need. */
export interface CountableFinding {
  kind: FindingKind
  state: FindingState
  stateUntil: Date | null
  factors: ExposureFactors
  /** GitHub's alert is stale: the lockfile is already patched. Left out of every count. */
  patchedInLockfile?: boolean
  /** Guard findings: the check and the current level. */
  guardCheck?: GuardCheck | null
  guardLevel?: GuardLevel | null
}

/**
 * Funnel of advisory findings for the UI. Every step narrows the previous one:
 * total > in deployed repos > runtime > critical or high > on a public app.
 * Fixed findings are left out of every number. Findings dismissed upstream stay in the
 * funnel (they are real) but are never exposed and never need action.
 */
export interface AdvisoryFunnel {
  total: number
  deployed: number
  runtime: number
  criticalOrHigh: number
  public: number
  /** Critical or high, runtime, public and not fixed: the last funnel step. */
  exposed: number
  /** Exposed and not covered by a snooze or acceptance that is still in force. */
  needsAction: number
  /** Dismissed on GitHub with no other source reporting them. Listed like accepted risks, never exposed. */
  dismissedUpstream: number
}

export interface BlindSpotCounts {
  total: number
  deployed: number
  public: number
  needsAction: number
}

export interface GuardCounts {
  /** Guard findings not fixed, accepted ones (turned off checks) included. */
  total: number
  /** Not fixed, per check and level. */
  byCheck: Record<GuardCheck, Record<GuardLevel, number>>
  /**
   * `warn` or `fail` on a running deployment, with no snooze or acceptance in force (a turned
   * off check is an acceptance). The nav badge.
   */
  needsAction: number
}

export interface FindingCounts {
  advisories: AdvisoryFunnel
  blindSpots: BlindSpotCounts
  guards: GuardCounts
}

function emptyGuardCounts(): GuardCounts {
  const byCheck = Object.fromEntries(
    GUARD_CHECKS.map((check) => [check, Object.fromEntries(GUARD_LEVELS.map((l) => [l, 0]))]),
  ) as GuardCounts['byCheck']
  return { total: 0, byCheck, needsAction: 0 }
}

/** A snooze or acceptance counts until it expires; scans flip it back to open afterwards. */
export function isDeferred(finding: Pick<CountableFinding, 'state' | 'stateUntil'>, now: Date) {
  if (finding.state !== 'snoozed' && finding.state !== 'accepted') return false
  return finding.stateUntil === null || finding.stateUntil.getTime() > now.getTime()
}

function isCriticalOrHigh(factors: ExposureFactors): boolean {
  return factors.severity === 'critical' || factors.severity === 'high'
}

/** True for an advisory finding that is critical or high, shipped at runtime, public and not fixed. */
export function isExposed(finding: CountableFinding): boolean {
  const { factors } = finding
  return (
    finding.kind === 'advisory' &&
    !finding.patchedInLockfile &&
    finding.state !== 'fixed' &&
    finding.state !== 'dismissed_upstream' &&
    factors.deployed &&
    factors.runtime &&
    isCriticalOrHigh(factors) &&
    factors.public
  )
}

/**
 * Funnel steps an advisory finding reaches, in order (the same rules as `countFindings`).
 * Empty for blind spots and fixed findings.
 */
export function funnelSteps(finding: CountableFinding): FunnelStep[] {
  if (finding.kind !== 'advisory' || finding.state === 'fixed' || finding.patchedInLockfile)
    return []
  const { factors } = finding
  const steps: FunnelStep[] = ['total']
  if (!factors.deployed) return steps
  steps.push('deployed')
  if (!factors.runtime) return steps
  steps.push('runtime')
  if (!isCriticalOrHigh(factors)) return steps
  steps.push('criticalOrHigh')
  if (!factors.public) return steps
  steps.push('public')
  if (finding.state !== 'dismissed_upstream') steps.push('exposed')
  return steps
}

export function countFindings(findings: readonly CountableFinding[], now: Date): FindingCounts {
  const advisories: AdvisoryFunnel = {
    total: 0,
    deployed: 0,
    runtime: 0,
    criticalOrHigh: 0,
    public: 0,
    exposed: 0,
    needsAction: 0,
    dismissedUpstream: 0,
  }
  const blindSpots: BlindSpotCounts = { total: 0, deployed: 0, public: 0, needsAction: 0 }
  const guards = emptyGuardCounts()

  for (const finding of findings) {
    // Coverage notes are neither advisories nor blind spots: counted nowhere here.
    // Stale alerts (patched in the lockfile) are not exposure either.
    if (finding.state === 'fixed' || finding.kind === 'coverage_note') continue
    if (finding.patchedInLockfile) continue
    const { factors } = finding
    if (finding.kind === 'blind_spot') {
      blindSpots.total++
      if (factors.deployed) blindSpots.deployed++
      if (factors.public) blindSpots.public++
      if (!isDeferred(finding, now)) blindSpots.needsAction++
      continue
    }
    if (finding.kind === 'guard') {
      if (!finding.guardCheck || !finding.guardLevel) continue
      guards.total++
      guards.byCheck[finding.guardCheck][finding.guardLevel]++
      if (finding.guardLevel !== 'unknown' && factors.deployed && !isDeferred(finding, now)) {
        guards.needsAction++
      }
      continue
    }
    advisories.total++
    if (finding.state === 'dismissed_upstream') advisories.dismissedUpstream++
    if (!factors.deployed) continue
    advisories.deployed++
    if (!factors.runtime) continue
    advisories.runtime++
    if (!isCriticalOrHigh(factors)) continue
    advisories.criticalOrHigh++
    if (!factors.public) continue
    advisories.public++
    if (finding.state === 'dismissed_upstream') continue
    advisories.exposed++
    if (!isDeferred(finding, now)) advisories.needsAction++
  }
  return { advisories, blindSpots, guards }
}
