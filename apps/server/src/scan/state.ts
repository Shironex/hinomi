import type { FindingState } from '@hinomi/shared'
import type { FindingRow } from '../db/schema.js'
import type { FindingsRepository } from '../repository/index.js'
import { currentTime } from '@hinomi/shared'

/**
 * Finding state machine on top of `findings.changeState`. Every transition
 * writes a finding_events row (through changeState) with the actor and an
 * event type:
 *
 * - user: `snoozed`, `accepted` (reason and an expiry in the future), `reopened` (cancel a decision)
 * - system: `snooze_expired`, `acceptance_expired` (back to open once the expiry passed),
 *   `fixed` (no source reports the advisory anymore), `resolved` (a blind spot cleared),
 *   `reopened` (a fixed or upstream dismissed finding came back),
 *   `dismissed_upstream` (GitHub dismissed the alert and no other source reports it; never `fixed`),
 *   `dismissal_noted` (GitHub dismissed it but another source still reports it; stays open)
 */
export type FindingEventType =
  | 'snoozed'
  | 'accepted'
  | 'reopened'
  | 'snooze_expired'
  | 'acceptance_expired'
  | 'fixed'
  | 'resolved'
  | 'dismissed_upstream'
  | 'dismissal_noted'

export type Actor = 'system' | 'user'

export class FindingTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FindingTransitionError'
  }
}

const DEFERRED: readonly FindingState[] = ['snoozed', 'accepted']

/** States a finding may move to by a user decision, per current state. */
const USER_TRANSITIONS: Record<FindingState, readonly FindingState[]> = {
  open: ['snoozed', 'accepted'],
  fixing: ['snoozed', 'accepted', 'open'],
  snoozed: ['snoozed', 'accepted', 'open'],
  accepted: ['accepted', 'snoozed', 'open'],
  // A fixed finding only comes back through a scan.
  fixed: [],
  // GitHub's dismissal is not the user's: they can defer it, but a plain reopen would fight the scan.
  dismissed_upstream: ['snoozed', 'accepted'],
}

export function canUserTransition(from: FindingState, to: FindingState): boolean {
  return USER_TRANSITIONS[from].includes(to)
}

function load(findings: FindingsRepository, id: number): FindingRow {
  const finding = findings.get(id)
  if (!finding) throw new FindingTransitionError(`Finding ${id} does not exist`)
  return finding
}

function requireUserTransition(finding: FindingRow, to: FindingState): void {
  if (!canUserTransition(finding.state, to)) {
    throw new FindingTransitionError(`A ${finding.state} finding cannot be moved to ${to}`)
  }
}

export interface DeferInput {
  reason: string
  /** Expiry. Null only together with `untilNewAdvisory`. */
  until: Date | null
  /** Lasts until a new advisory appears for the same package and repo, instead of a date. */
  untilNewAdvisory?: boolean
  now?: Date
}

function validateDefer(finding: FindingRow, input: DeferInput, now: Date): string {
  const reason = input.reason.trim()
  if (reason === '') throw new FindingTransitionError('A reason is required')
  if (input.untilNewAdvisory) {
    if (input.until !== null) {
      throw new FindingTransitionError('Give either an expiry date or until a new advisory')
    }
    if (finding.kind !== 'advisory') {
      throw new FindingTransitionError('Only advisories can wait for a new advisory')
    }
    return reason
  }
  if (
    input.until === null ||
    Number.isNaN(input.until.getTime()) ||
    input.until.getTime() <= now.getTime()
  ) {
    throw new FindingTransitionError('The expiry must be in the future')
  }
  return reason
}

function defer(
  findings: FindingsRepository,
  id: number,
  state: 'snoozed' | 'accepted',
  input: DeferInput,
): FindingRow {
  const now = input.now ?? currentTime()
  const finding = load(findings, id)
  requireUserTransition(finding, state)
  const reason = validateDefer(finding, input, now)
  const untilNewAdvisory = input.untilNewAdvisory === true
  return findings.changeState(
    id,
    {
      state,
      reason,
      until: untilNewAdvisory ? null : input.until,
      untilNewAdvisory,
      actor: 'user',
      eventType: state,
      ...(untilNewAdvisory && { data: { untilNewAdvisory: true } }),
    },
    now,
  )
}

/** User snoozes a finding until a date. It reopens on its own once that date passes. */
export function snoozeFinding(findings: FindingsRepository, id: number, input: DeferInput) {
  return defer(findings, id, 'snoozed', input)
}

/** User accepts the risk until a date. It reopens on its own once that date passes. */
export function acceptFinding(findings: FindingsRepository, id: number, input: DeferInput) {
  return defer(findings, id, 'accepted', input)
}

/** User cancels a snooze or acceptance. */
export function reopenFinding(
  findings: FindingsRepository,
  id: number,
  input: { reason?: string | null; now?: Date } = {},
): FindingRow {
  const finding = load(findings, id)
  requireUserTransition(finding, 'open')
  return findings.changeState(
    id,
    { state: 'open', reason: input.reason ?? null, actor: 'user', eventType: 'reopened' },
    input.now ?? currentTime(),
  )
}

/**
 * Scan: nothing reports the finding anymore. Advisories become `fixed`
 * (event `fixed`), blind spots and coverage notes too (event `resolved`). No-op when already fixed.
 */
export function markFixed(
  findings: FindingsRepository,
  finding: FindingRow,
  now: Date,
  data?: Record<string, unknown>,
): FindingRow | null {
  if (finding.state === 'fixed') return null
  return findings.changeState(
    finding.id,
    {
      state: 'fixed',
      actor: 'system',
      eventType: finding.kind === 'advisory' ? 'fixed' : 'resolved',
      ...(data && { data }),
    },
    now,
  )
}

/** Scan: a fixed finding was reported again. No-op unless it is fixed. */
export function reopenIfFixed(
  findings: FindingsRepository,
  finding: FindingRow,
  now: Date,
): FindingRow | null {
  if (finding.state !== 'fixed') return null
  return findings.changeState(
    finding.id,
    { state: 'open', actor: 'system', eventType: 'reopened', data: { reason: 'reappeared' } },
    now,
  )
}

/** True when a snooze or acceptance has an expiry that has passed. */
export function isExpired(finding: Pick<FindingRow, 'state' | 'stateUntil'>, now: Date): boolean {
  return (
    DEFERRED.includes(finding.state) &&
    finding.stateUntil !== null &&
    finding.stateUntil.getTime() <= now.getTime()
  )
}

/**
 * Scan: moves every snoozed or accepted finding whose expiry passed back to
 * open. Returns the reopened findings.
 */
export function expireDeferred(findings: FindingsRepository, now: Date): FindingRow[] {
  const candidates = [
    ...findings.list({ state: 'snoozed' }),
    ...findings.list({ state: 'accepted' }),
  ]
  return candidates
    .filter((finding) => isExpired(finding, now))
    .map((finding) =>
      findings.changeState(
        finding.id,
        {
          state: 'open',
          actor: 'system',
          eventType: finding.state === 'snoozed' ? 'snooze_expired' : 'acceptance_expired',
          data: { expiredAt: finding.stateUntil?.toISOString() ?? null },
        },
        now,
      ),
    )
}

/**
 * Scan: a new advisory finding appeared. Every snooze or acceptance on the same repo and
 * package that waits for a new advisory ends now (event `snooze_expired` or
 * `acceptance_expired` with `reason: new_advisory`). Returns the reopened findings.
 */
export function expireForNewAdvisory(
  findings: FindingsRepository,
  advisoryOf: (id: number) => { ecosystem: string; packageName: string } | undefined,
  created: FindingRow,
  now: Date,
): FindingRow[] {
  if (created.kind !== 'advisory' || created.repoId === null || created.advisoryId === null) {
    return []
  }
  const pkg = advisoryOf(created.advisoryId)
  if (!pkg) return []
  return findings
    .list({ repoId: created.repoId, kind: 'advisory' })
    .filter((finding) => {
      if (finding.id === created.id || !finding.stateUntilNewAdvisory) return false
      if (!DEFERRED.includes(finding.state) || finding.advisoryId === null) return false
      if (finding.advisoryId === created.advisoryId) return false
      const other = advisoryOf(finding.advisoryId)
      return other?.ecosystem === pkg.ecosystem && other.packageName === pkg.packageName
    })
    .map((finding) =>
      findings.changeState(
        finding.id,
        {
          state: 'open',
          actor: 'system',
          eventType: finding.state === 'snoozed' ? 'snooze_expired' : 'acceptance_expired',
          data: { reason: 'new_advisory', findingId: created.id },
        },
        now,
      ),
    )
}

/** What GitHub recorded when someone dismissed the alert. */
export interface UpstreamDismissal {
  reason: string | null
  comment: string | null
  dismissedAt: string
  alertNumbers: number[]
}

/** States a scan may move to `dismissed_upstream`. A user's snooze or acceptance is left alone. */
const DISMISSABLE: readonly FindingState[] = ['open', 'fixing', 'fixed']

/**
 * Scan: GitHub dismissed the alert and nothing else reports it. The reason and
 * comment go into the event. No-op unless the finding is open, fixing or fixed.
 */
export function markDismissedUpstream(
  findings: FindingsRepository,
  finding: FindingRow,
  now: Date,
  dismissal: UpstreamDismissal,
): FindingRow | null {
  if (!DISMISSABLE.includes(finding.state)) return null
  return findings.changeState(
    finding.id,
    {
      state: 'dismissed_upstream',
      reason: dismissal.reason,
      actor: 'system',
      eventType: 'dismissed_upstream',
      data: { ...dismissal },
    },
    now,
  )
}

/** Scan: something reports a finding that was dismissed upstream. No-op unless it is. */
export function reopenIfDismissedUpstream(
  findings: FindingsRepository,
  finding: FindingRow,
  now: Date,
  why: 'reopened_upstream' | 'still_reported',
): FindingRow | null {
  if (finding.state !== 'dismissed_upstream') return null
  return findings.changeState(
    finding.id,
    { state: 'open', actor: 'system', eventType: 'reopened', data: { reason: why } },
    now,
  )
}

/** Scan: a dismissal GitHub reports while another source still reports the finding. Noted once. */
export function noteUpstreamDismissal(
  findings: FindingsRepository,
  finding: FindingRow,
  now: Date,
  dismissal: UpstreamDismissal,
): boolean {
  const known = findings.listEvents(finding.id).some((event) => {
    const data = event.data as { dismissedAt?: unknown } | null
    return event.type === 'dismissal_noted' && data?.dismissedAt === dismissal.dismissedAt
  })
  if (known) return false
  findings.addEvent({
    findingId: finding.id,
    type: 'dismissal_noted',
    actor: 'system',
    data: { ...dismissal, note: 'Dismissed on GitHub, still reported by another source' },
    at: now,
  })
  return true
}
