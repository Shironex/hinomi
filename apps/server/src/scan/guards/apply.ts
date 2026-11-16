import {
  guardEvidenceSchema,
  type GuardCheck,
  type GuardEvidence,
  type GuardLevel,
} from '@hinomi/shared'
import type { Repositories } from '../../repository/index.js'
import { guardFindingKey } from '../../repository/index.js'
import type { FindingChange } from '../apply.js'
import { errorMessage } from '../collect.js'
import { reconcileOverride, type OverrideIndex } from '../overrides.js'
import { markFixed, reopenIfFixed } from '../state.js'
import { newlyArchivedRepos, type Worsening } from './archived-deployed.js'
import type { Guard, GuardContext, GuardOutcome, GuardSubjectResult } from './types.js'

interface GuardLog {
  warn(message: string, data?: Record<string, unknown>): void
}

/** Worse is higher. `unknown` sits below `warn`: learning the signal is bad is an escalation. */
const LEVEL_ORDER: Record<GuardLevel, number> = { unknown: 1, warn: 2, fail: 3 }
const OUTCOME_ORDER: Record<GuardOutcome['level'], number> = { pass: 0, ...LEVEL_ORDER }

function parseEvidence(
  guard: Guard,
  result: GuardSubjectResult,
  log: GuardLog,
): GuardEvidence | null | 'invalid' {
  if (result.level === null || result.evidence === undefined) return null
  const parsed = guardEvidenceSchema.safeParse(result.evidence)
  if (parsed.success && parsed.data.check === guard.check) return parsed.data
  log.warn('scan: a guard returned evidence that does not match its check', {
    check: guard.check,
    error: parsed.success ? `evidence is for ${parsed.data.check}` : parsed.error.message,
  })
  return 'invalid'
}

/**
 * Validates and deduplicates what one check returned. A subject outside the context or evidence
 * that fails its schema is dropped with a warning (the row is left alone, like `null`); a pass
 * with bad evidence still passes, without it. Two results for one subject: the worse wins.
 */
export function toOutcomes(
  guard: Guard,
  results: readonly GuardSubjectResult[],
  ctx: Pick<GuardContext, 'deployments' | 'repos'>,
  log: GuardLog,
): GuardOutcome[] {
  const deploymentIds = new Set(ctx.deployments.map((d) => d.id))
  const repoIds = new Set(ctx.repos.map((r) => r.id))
  const byKey = new Map<string, GuardOutcome>()
  for (const result of results) {
    const { subject } = result
    const known =
      'deploymentId' in subject
        ? deploymentIds.has(subject.deploymentId)
        : repoIds.has(subject.repoId)
    if (!known) {
      log.warn('scan: a guard returned a subject outside its context', {
        check: guard.check,
        subject,
      })
      continue
    }
    if (result.level === null) continue
    const evidence = parseEvidence(guard, result, log)
    let outcome: GuardOutcome
    if (result.level === 'pass') {
      outcome = {
        check: guard.check,
        subject,
        level: 'pass',
        evidence: evidence === 'invalid' ? null : evidence,
      }
    } else {
      if (evidence === null || evidence === 'invalid') continue
      outcome = { check: guard.check, subject, level: result.level, evidence }
    }
    const key = guardFindingKey(guard.check, subject)
    const seen = byKey.get(key)
    if (!seen || OUTCOME_ORDER[outcome.level] > OUTCOME_ORDER[seen.level]) byKey.set(key, outcome)
  }
  return [...byKey.values()]
}

/**
 * Checks whose evidence can get worse at the same level, and how to tell: a reason and event
 * data, or null. Such a change escalates like a worse level does.
 */
const WORSENED: Partial<
  Record<GuardCheck, (before: unknown, after: GuardEvidence) => Worsening | null>
> = { archived_deployed: newlyArchivedRepos }

/** Runs every check. One that throws is logged and skipped; the others still count. */
export async function evaluateGuards(
  guards: readonly Guard[],
  ctx: GuardContext,
  log: GuardLog,
): Promise<GuardOutcome[]> {
  const outcomes: GuardOutcome[] = []
  for (const guard of guards) {
    try {
      outcomes.push(...toOutcomes(guard, await guard.run(ctx), ctx, log))
    } catch (error) {
      log.warn('scan: a guard failed', { check: guard.check, error: errorMessage(error) })
    }
  }
  return outcomes
}

function applyOne(
  repositories: Repositories,
  outcome: GuardOutcome,
  overrides: OverrideIndex,
  now: Date,
  changes: FindingChange[],
): void {
  const { findings } = repositories
  const existing = findings.getByKey(guardFindingKey(outcome.check, outcome.subject))
  const push = (findingId: number, change: FindingChange['change'] | null) => {
    if (change) changes.push({ findingId, change })
  }

  if (outcome.level === 'pass') {
    if (!existing) return
    if (outcome.evidence) findings.setEvidence(existing.id, outcome.evidence)
    if (markFixed(findings, existing, now)) push(existing.id, 'fixed')
    return
  }

  const escalate = (reason: string, data: Record<string, unknown>) => {
    // Snooze means "not now", not "never tell me it got worse". A turned off check stays off.
    const current = findings.get(finding.id)!
    const deferred = current.state === 'snoozed' || current.state === 'accepted'
    if (deferred && current.stateUntil !== null) {
      findings.changeState(
        current.id,
        { state: 'open', actor: 'system', eventType: 'reopened', data: { reason: 'escalated' } },
        now,
      )
    }
    // Written after the reopen: the latest announcement event is the escalation.
    findings.addEvent({ findingId: current.id, type: 'escalated', reason, data, at: now })
    push(current.id, 'escalated')
  }

  const { finding, created } = findings.observe(
    {
      kind: 'guard',
      guardCheck: outcome.check,
      subject: outcome.subject,
      guardLevel: outcome.level,
      evidence: outcome.evidence,
    },
    now,
  )
  if (created) push(finding.id, 'opened')
  else if (existing?.state === 'fixed') {
    if (reopenIfFixed(findings, finding, now)) push(finding.id, 'reopened')
  } else if (existing?.guardLevel && existing.guardLevel !== outcome.level) {
    const from = existing.guardLevel
    const reason = `${from} -> ${outcome.level}`
    const data = { from, to: outcome.level }
    if (LEVEL_ORDER[outcome.level] > LEVEL_ORDER[from]) {
      escalate(reason, data)
    } else {
      findings.addEvent({ findingId: finding.id, type: 'level_changed', reason, data, at: now })
      push(finding.id, 'level_changed')
    }
  } else if (existing?.guardLevel === outcome.level) {
    // The same level can still be worse news (archived_deployed: another repo is archived now).
    const worse = WORSENED[outcome.check]?.(existing.evidence, outcome.evidence)
    if (worse) escalate(worse.reason, { from: outcome.level, to: outcome.level, ...worse.data })
  }

  const current = findings.get(finding.id)
  if (!current) return
  push(
    current.id,
    reconcileOverride(findings, current, overrides.covering(outcome.check, outcome.subject), now),
  )
}

/**
 * Writes guard outcomes, mirroring `applyBlindSpots`, in one transaction: opens new findings,
 * updates level and evidence in place, escalates (event `escalated`, reopening a snoozed or
 * accepted row) on a worse level or worse evidence at the same level, or notes an improvement (event `level_changed`), reopens fixed rows that fail
 * again, resolves passes, and applies check overrides (event `turned_off`).
 */
export function applyGuards(
  repositories: Repositories,
  outcomes: readonly GuardOutcome[],
  overrides: OverrideIndex,
  now: Date,
): FindingChange[] {
  return repositories.db.transaction(() => {
    const changes: FindingChange[] = []
    for (const outcome of outcomes) applyOne(repositories, outcome, overrides, now, changes)
    return changes
  })
}
