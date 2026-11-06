import type { FindingKind, FindingState, FunnelStep } from '@hinomi/shared'
import type { ExposureFactors } from './rank.js'

/** The fields of a ranked finding the counts need. */
export interface CountableFinding {
  kind: FindingKind
  state: FindingState
  stateUntil: Date | null
  factors: ExposureFactors
  /** GitHub's alert is stale: the lockfile is already patched. Left out of every count. */
  patchedInLockfile?: boolean
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

export interface FindingCounts {
  advisories: AdvisoryFunnel
  blindSpots: BlindSpotCounts
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
  return { advisories, blindSpots }
}
