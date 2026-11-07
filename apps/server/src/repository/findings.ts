import {
  COVERAGE_NOTE_TYPES,
  type BlindSpotType,
  type CoverageNoteType,
  type FindingKind,
  type FindingScope,
  type FindingState,
  type GuardCheck,
  type GuardEvidence,
  type GuardLevel,
  type Reporter,
} from '@hinomi/shared'
import { and, asc, desc, eq, gte, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  findingEvents,
  findings,
  type FindingEventRow,
  type FindingRow,
  type NewFindingEventRow,
} from '../db/schema.js'
import { currentTime } from '@hinomi/shared'

/** Dedupe key of an advisory finding: one row per advisory and repo. */
export function advisoryFindingKey(advisoryId: number, repoId: number): string {
  return `advisory:${advisoryId}:repo:${repoId}`
}

/** Dedupe key of a blind spot: one row per type and subject (a repo or a deployment). */
export function blindSpotFindingKey(
  type: BlindSpotType,
  subject: { repoId: number } | { deploymentId: number },
): string {
  return 'repoId' in subject
    ? `blind:${type}:repo:${subject.repoId}`
    : `blind:${type}:deployment:${subject.deploymentId}`
}

/** Dedupe key of a coverage note: one row per type and deployment. */
export function coverageNoteFindingKey(type: CoverageNoteType, deploymentId: number): string {
  return `note:${type}:deployment:${deploymentId}`
}

/** Dedupe key of a coverage note about a repo (a release without a lockfile at its tag). */
export function repoCoverageNoteFindingKey(type: CoverageNoteType, repoId: number): string {
  return `note:${type}:repo:${repoId}`
}

/**
 * The type of a coverage note, read back from its dedupe key (`note:{type}:...`). The table has
 * no column for it; null for any other finding or a key this version does not know.
 */
export function coverageNoteTypeOf(finding: {
  kind: FindingKind
  dedupeKey: string
}): CoverageNoteType | null {
  if (finding.kind !== 'coverage_note') return null
  const type = finding.dedupeKey.split(':')[1]
  return COVERAGE_NOTE_TYPES.find((t) => t === type) ?? null
}

/** What a guard finding is about: one deployment or one repo. */
export type GuardSubject = { deploymentId: number } | { repoId: number }

/** Dedupe key of a guard finding: one row per check and subject; level and evidence update in place. */
export function guardFindingKey(check: GuardCheck, subject: GuardSubject): string {
  return 'deploymentId' in subject
    ? `guard:${check}:deployment:${subject.deploymentId}`
    : `guard:${check}:repo:${subject.repoId}`
}

/**
 * Dedupe key of a desktop release advisory: a separate row from the default branch advisory on
 * the same repo (the version at the tag can differ). It follows the latest tag (`release_tag`
 * updates), it is not one row per tag.
 */
export function releaseAdvisoryFindingKey(advisoryId: number, repoId: number): string {
  return `advisory:${advisoryId}:repo:${repoId}:release`
}

/** Dedupe key of an advisory an image scan reported on a deployment (`repo_id` may stay null). */
export function imageAdvisoryFindingKey(advisoryId: number, deploymentId: number): string {
  return `advisory:${advisoryId}:deployment:${deploymentId}:image`
}

export type ObserveFindingInput =
  | {
      kind: Extract<FindingKind, 'advisory'>
      advisoryId: number
      repoId: number
      scope?: FindingScope
      reportedBy: Reporter[]
      manifestPaths?: string[]
      installedVersion?: string | null
      /** The lockfile already resolves only patched versions; left alone when undefined. */
      patchedInLockfile?: boolean
      /** Chain from a lockfile; left alone when undefined. */
      dependencyPath?: string[] | null
      /**
       * Desktop release advisory: the tag that was scanned. Makes it a separate row from the
       * default branch advisory (releaseAdvisoryFindingKey); the row follows the latest tag.
       */
      releaseTag?: string
      /** Release advisories: the default branch no longer has it. Left alone when undefined. */
      fixedOnDefaultBranch?: boolean
    }
  | {
      kind: Extract<FindingKind, 'blind_spot'>
      blindSpotType: BlindSpotType
      repoId?: number
      deploymentId?: number
    }
  | {
      kind: Extract<FindingKind, 'coverage_note'>
      coverageNoteType: CoverageNoteType
      /** The subject: a deployment, or a repo for notes about a repo. */
      deploymentId?: number
      repoId?: number
    }
  | {
      kind: Extract<FindingKind, 'guard'>
      guardCheck: GuardCheck
      subject: GuardSubject
      /** Written on create and on every later observation. */
      guardLevel: GuardLevel
      evidence: GuardEvidence
    }

export interface ChangeStateInput {
  state: FindingState
  reason?: string | null
  until?: Date | null
  /** A snooze or acceptance that lasts until a new advisory for the same package. */
  untilNewAdvisory?: boolean
  actor: 'system' | 'user'
  /** Event type written to history. Defaults to `state_changed`. */
  eventType?: string
  data?: Record<string, unknown>
}

export interface ListFindingsFilter {
  repoId?: number
  deploymentId?: number
  advisoryId?: number
  kind?: FindingKind
  state?: FindingState
}

export type FindingsRepository = ReturnType<typeof createFindingsRepository>

function keyFor(input: ObserveFindingInput): string {
  if (input.kind === 'advisory') {
    return input.releaseTag === undefined
      ? advisoryFindingKey(input.advisoryId, input.repoId)
      : releaseAdvisoryFindingKey(input.advisoryId, input.repoId)
  }
  if (input.kind === 'coverage_note') {
    if (input.deploymentId !== undefined) {
      return coverageNoteFindingKey(input.coverageNoteType, input.deploymentId)
    }
    if (input.repoId !== undefined) {
      return repoCoverageNoteFindingKey(input.coverageNoteType, input.repoId)
    }
    throw new Error('A coverage note needs a deploymentId or a repoId')
  }
  if (input.kind === 'guard') return guardFindingKey(input.guardCheck, input.subject)
  if (input.repoId !== undefined)
    return blindSpotFindingKey(input.blindSpotType, { repoId: input.repoId })
  if (input.deploymentId !== undefined)
    return blindSpotFindingKey(input.blindSpotType, { deploymentId: input.deploymentId })
  throw new Error('A blind spot finding needs a repoId or a deploymentId')
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])]
}

/**
 * Storage primitives for findings and their history. The state machine
 * (when to reopen, expire or fix) lives with the finding logic; every state
 * change made here writes a finding_events row in the same transaction.
 */
export function createFindingsRepository(db: Db) {
  function get(id: number): FindingRow | undefined {
    return db.select().from(findings).where(eq(findings.id, id)).get()
  }

  function addEvent(event: Omit<NewFindingEventRow, 'id'>): FindingEventRow {
    return db.insert(findingEvents).values(event).returning().get()
  }

  return {
    get,

    getByKey(dedupeKey: string): FindingRow | undefined {
      return db.select().from(findings).where(eq(findings.dedupeKey, dedupeKey)).get()
    },

    list(filter: ListFindingsFilter = {}): FindingRow[] {
      const conditions: SQL[] = []
      if (filter.repoId !== undefined) conditions.push(eq(findings.repoId, filter.repoId))
      if (filter.deploymentId !== undefined)
        conditions.push(eq(findings.deploymentId, filter.deploymentId))
      if (filter.advisoryId !== undefined)
        conditions.push(eq(findings.advisoryId, filter.advisoryId))
      if (filter.kind !== undefined) conditions.push(eq(findings.kind, filter.kind))
      if (filter.state !== undefined) conditions.push(eq(findings.state, filter.state))
      return db
        .select()
        .from(findings)
        .where(and(...conditions))
        .orderBy(asc(findings.id))
        .all()
    },

    /**
     * Records that a scan saw this finding. A new finding is created as open
     * with an `opened` event. An existing one gets lastSeenAt bumped, its
     * reporters merged and its details refreshed; its state is left alone.
     */
    observe(
      input: ObserveFindingInput,
      seenAt: Date = currentTime(),
    ): { finding: FindingRow; created: boolean } {
      const dedupeKey = keyFor(input)
      return db.transaction(() => {
        const existing = db.select().from(findings).where(eq(findings.dedupeKey, dedupeKey)).get()

        if (!existing) {
          const finding = db
            .insert(findings)
            .values({
              dedupeKey,
              kind: input.kind,
              firstSeenAt: seenAt,
              lastSeenAt: seenAt,
              ...(input.kind === 'advisory'
                ? {
                    advisoryId: input.advisoryId,
                    repoId: input.repoId,
                    scope: input.scope ?? 'unknown',
                    reportedBy: union([], input.reportedBy),
                    manifestPaths: input.manifestPaths ?? [],
                    installedVersion: input.installedVersion ?? null,
                    patchedInLockfile: input.patchedInLockfile ?? false,
                    dependencyPath: input.dependencyPath ?? null,
                    releaseTag: input.releaseTag ?? null,
                    fixedOnDefaultBranch: input.fixedOnDefaultBranch ?? false,
                  }
                : input.kind === 'coverage_note'
                  ? { deploymentId: input.deploymentId ?? null, repoId: input.repoId ?? null }
                  : input.kind === 'guard'
                    ? {
                        guardCheck: input.guardCheck,
                        guardLevel: input.guardLevel,
                        evidence: input.evidence,
                        repoId: 'repoId' in input.subject ? input.subject.repoId : null,
                        deploymentId:
                          'deploymentId' in input.subject ? input.subject.deploymentId : null,
                      }
                    : {
                        blindSpotType: input.blindSpotType,
                        repoId: input.repoId ?? null,
                        deploymentId: input.deploymentId ?? null,
                      }),
            })
            .returning()
            .get()
          addEvent({ findingId: finding.id, type: 'opened', toState: 'open', at: seenAt })
          return { finding, created: true }
        }

        const finding = db
          .update(findings)
          .set({
            lastSeenAt: seenAt,
            ...(input.kind === 'advisory' && {
              ...(input.scope !== undefined && { scope: input.scope }),
              reportedBy: union(existing.reportedBy, input.reportedBy),
              manifestPaths: union(existing.manifestPaths, input.manifestPaths ?? []),
              ...(input.installedVersion !== undefined && {
                installedVersion: input.installedVersion,
              }),
              ...(input.dependencyPath !== undefined && { dependencyPath: input.dependencyPath }),
              ...(input.patchedInLockfile !== undefined && {
                patchedInLockfile: input.patchedInLockfile,
              }),
              ...(input.releaseTag !== undefined && { releaseTag: input.releaseTag }),
              ...(input.fixedOnDefaultBranch !== undefined && {
                fixedOnDefaultBranch: input.fixedOnDefaultBranch,
              }),
            }),
            ...(input.kind === 'guard' && {
              guardLevel: input.guardLevel,
              evidence: input.evidence,
            }),
          })
          .where(eq(findings.id, existing.id))
          .returning()
          .get()
        return { finding, created: false }
      })
    },

    /** Replaces a guard finding's evidence without touching its level or state (a pass keeps what it read). */
    setEvidence(id: number, evidence: GuardEvidence): void {
      db.update(findings).set({ evidence }).where(eq(findings.id, id)).run()
    },

    /** Replaces the set of sources that report a finding (for example after a rescan). */
    setReportedBy(id: number, reportedBy: Reporter[]): void {
      db.update(findings)
        .set({ reportedBy: union([], reportedBy) })
        .where(eq(findings.id, id))
        .run()
    },

    /**
     * Moves a finding to a new state and writes the history event in one
     * transaction. Entering `fixed` sets fixedAt; leaving it clears fixedAt.
     */
    changeState(id: number, input: ChangeStateInput, at: Date = currentTime()): FindingRow {
      return db.transaction(() => {
        const current = get(id)
        if (!current) throw new Error(`Finding ${id} does not exist`)
        const reason = input.reason ?? null
        const until = input.until ?? null
        const updated = db
          .update(findings)
          .set({
            state: input.state,
            stateReason: reason,
            stateUntil: until,
            stateUntilNewAdvisory: input.untilNewAdvisory ?? false,
            fixedAt: input.state === 'fixed' ? (current.fixedAt ?? at) : null,
          })
          .where(eq(findings.id, id))
          .returning()
          .get()
        addEvent({
          findingId: id,
          type: input.eventType ?? 'state_changed',
          fromState: current.state,
          toState: input.state,
          reason,
          until,
          actor: input.actor,
          data: input.data ?? null,
          at,
        })
        return updated
      })
    },

    /** Writes a history event that is not a state change (a note, a new reporter, ...). */
    addEvent,

    /** Events of every finding written at or after `since`, oldest first. */
    listEventsSince(since: Date): FindingEventRow[] {
      return db
        .select()
        .from(findingEvents)
        .where(gte(findingEvents.at, since))
        .orderBy(asc(findingEvents.at), asc(findingEvents.id))
        .all()
    },

    /** Latest events across every finding, newest first (activity feed). */
    listRecentEvents(limit = 20): FindingEventRow[] {
      return db
        .select()
        .from(findingEvents)
        .orderBy(desc(findingEvents.at), desc(findingEvents.id))
        .limit(limit)
        .all()
    },

    /** History of a finding, newest first. */
    listEvents(findingId: number): FindingEventRow[] {
      return db
        .select()
        .from(findingEvents)
        .where(eq(findingEvents.findingId, findingId))
        .orderBy(desc(findingEvents.at), desc(findingEvents.id))
        .all()
    },
  }
}
