import type { FindingState } from '@hinomi/shared'
import type { FindingRow } from '../db/schema.js'
import type { FindingsRepository } from '../repository/index.js'

/**
 * Finding state machine on top of `findings.changeState`. Every transition
 * writes a finding_events row (through changeState) with the actor and an
 * event type:
 *
 * - user: `snoozed`, `accepted` (reason and an expiry in the future), `reopened` (cancel a decision)
 * - system: `snooze_expired`, `acceptance_expired` (back to open once the expiry passed),
 *   `fixed` (no source reports the advisory anymore), `resolved` (a blind spot cleared),
 *   `reopened` (a fixed finding came back)
 */
export type FindingEventType =
  | 'snoozed'
  | 'accepted'
  | 'reopened'
  | 'snooze_expired'
  | 'acceptance_expired'
  | 'fixed'
  | 'resolved'

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
  until: Date
  now?: Date
}

function validateDefer(input: DeferInput, now: Date): string {
  const reason = input.reason.trim()
  if (reason === '') throw new FindingTransitionError('A reason is required')
  if (Number.isNaN(input.until.getTime()) || input.until.getTime() <= now.getTime()) {
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
  const now = input.now ?? new Date()
  const finding = load(findings, id)
  requireUserTransition(finding, state)
  const reason = validateDefer(input, now)
  return findings.changeState(
    id,
    { state, reason, until: input.until, actor: 'user', eventType: state },
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
    input.now ?? new Date(),
  )
}

/**
 * Scan: nothing reports the finding anymore. Advisories become `fixed`
 * (event `fixed`), blind spots too (event `resolved`). No-op when already fixed.
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
      eventType: finding.kind === 'blind_spot' ? 'resolved' : 'fixed',
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
