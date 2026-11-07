import {
  FIX_RUN_BRANCHES,
  FIX_RUN_TERMINAL_STATES,
  currentTime,
  type FixChecksMode,
  type FixResultV1,
  type FixRunDeployment,
  type FixRunKind,
  type FixRunState,
  type FixRunnerKind,
  type FixRunVerification,
  type FixRunWarning,
} from '@hinomi/shared'
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { fixRuns, type FixRunRow } from '../db/schema.js'
import {
  FIX_RUN_EVENT_SOURCES,
  transitionFixRun,
  type FixRunEvent,
  type FixRunRejection,
  type FixRunTracked,
} from './fix-run-transitions.js'

export interface CreateFixRunInput {
  repoId: number
  /** The plan row the run applies, with the scan and version it was built from. */
  plan: { fixPlanId: number | null; scanRunId: number; version: number }
  runner: FixRunnerKind
  kind: FixRunKind
  correlationId: string
  checksMode: FixChecksMode
  /** Defaults to the kind's branch (FIX_RUN_BRANCHES). */
  branch?: string
}

export interface CreatedFixRun {
  run: FixRunRow
  /** Open runs of the same repo and kind that the new run superseded. */
  superseded: FixRunRow[]
}

export type ApplyFixRunEventResult =
  | { ok: true; run: FixRunRow; changed: boolean }
  | { ok: false; rejection: FixRunRejection | { code: 'not_found'; message: string } }

export interface FixRunEtags {
  run?: string | null
  pr?: string | null
  checks?: string | null
}

/** What the deployment link and the verification store on a run. Undefined keeps a value. */
export interface FixRunVerifyPatch {
  deployLinks?: FixRunDeployment[] | null
  warnings?: FixRunWarning[]
  verification?: FixRunVerification | null
}

/** Default page of run lists. */
export const FIX_RUNS_LIST_LIMIT = 50

const TERMINAL = [...FIX_RUN_TERMINAL_STATES]

type FixRunsDb = Pick<Db, 'select' | 'update'>

function trackedFields(run: FixRunTracked): FixRunTracked {
  return {
    state: run.state,
    stateReason: run.stateReason,
    githubRunId: run.githubRunId,
    githubRunAttempt: run.githubRunAttempt,
    headSha: run.headSha,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    prDraft: run.prDraft,
    mergeSha: run.mergeSha,
    dispatchedAt: run.dispatchedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    pushedAt: run.pushedAt,
    prOpenedAt: run.prOpenedAt,
    checksUpdatedAt: run.checksUpdatedAt,
    mergedAt: run.mergedAt,
    closedAt: run.closedAt,
    deployedAt: run.deployedAt,
    rescannedAt: run.rescannedAt,
    endedAt: run.endedAt,
    stateChangedAt: run.stateChangedAt,
  }
}

function applyTo(
  db: FixRunsDb,
  run: FixRunRow,
  event: FixRunEvent,
  now: Date,
): ApplyFixRunEventResult {
  const next = transitionFixRun(run, event, now)
  if (!next.ok || !next.changed) return next
  const linked = next.run.githubRunId
  if (linked !== null && linked !== run.githubRunId) {
    const other = db
      .select({ id: fixRuns.id })
      .from(fixRuns)
      .where(
        and(
          eq(fixRuns.repoId, run.repoId),
          eq(fixRuns.githubRunId, linked),
          ne(fixRuns.id, run.id),
        ),
      )
      .get()
    if (other) {
      const message = `workflow run ${linked} is already linked to fix run ${other.id}`
      return { ok: false, rejection: { code: 'conflict', message } }
    }
  }
  const row = db
    .update(fixRuns)
    .set(trackedFields(next.run))
    .where(eq(fixRuns.id, run.id))
    .returning()
    .get()
  return { ok: true, run: row ?? next.run, changed: true }
}

export type FixRunsRepository = ReturnType<typeof createFixRunsRepository>

export function createFixRunsRepository(db: Db) {
  const get = (id: number): FixRunRow | undefined =>
    db.select().from(fixRuns).where(eq(fixRuns.id, id)).get()

  return {
    get,

    getByCorrelationId(correlationId: string): FixRunRow | undefined {
      return db.select().from(fixRuns).where(eq(fixRuns.correlationId, correlationId)).get()
    },

    /**
     * Records a new run in `pending`, before the dispatch goes out, and supersedes the repo's
     * open runs of the same kind that have not merged yet, in one transaction.
     */
    create(input: CreateFixRunInput, now: Date = currentTime()): CreatedFixRun {
      return db.transaction((tx) => {
        const run = tx
          .insert(fixRuns)
          .values({
            repoId: input.repoId,
            fixPlanId: input.plan.fixPlanId,
            planScanRunId: input.plan.scanRunId,
            planVersion: input.plan.version,
            runner: input.runner,
            kind: input.kind,
            correlationId: input.correlationId,
            branch: input.branch ?? FIX_RUN_BRANCHES[input.kind],
            checksMode: input.checksMode,
            state: 'pending',
            createdAt: now,
            stateChangedAt: now,
          })
          .returning()
          .get()
        const open = tx
          .select()
          .from(fixRuns)
          .where(
            and(
              eq(fixRuns.repoId, input.repoId),
              eq(fixRuns.kind, input.kind),
              inArray(fixRuns.state, [...FIX_RUN_EVENT_SOURCES.superseded]),
              ne(fixRuns.id, run.id),
            ),
          )
          .all()
        const superseded = open.flatMap((previous) => {
          const result = applyTo(tx, previous, { type: 'superseded', byRunId: run.id }, now)
          return result.ok && result.changed ? [result.run] : []
        })
        return { run, superseded }
      })
    },

    /** Applies one polled or webhook event through the state machine, in a transaction. */
    applyEvent(id: number, event: FixRunEvent, now: Date = currentTime()): ApplyFixRunEventResult {
      return db.transaction((tx) => {
        const run = tx.select().from(fixRuns).where(eq(fixRuns.id, id)).get()
        if (!run) return { ok: false, rejection: { code: 'not_found', message: `no run ${id}` } }
        return applyTo(tx, run, event, now)
      })
    },

    /**
     * Stores deployment links, warnings and the verification, and applies `event` with them in
     * one transaction. When the event is refused nothing is written, so a run that already ended
     * keeps what it recorded.
     */
    saveVerify(
      id: number,
      patch: FixRunVerifyPatch,
      event: FixRunEvent | null = null,
      now: Date = currentTime(),
    ): ApplyFixRunEventResult {
      return db.transaction((tx) => {
        const run = tx.select().from(fixRuns).where(eq(fixRuns.id, id)).get()
        if (!run) return { ok: false, rejection: { code: 'not_found', message: `no run ${id}` } }
        let current = run
        let changed = false
        if (event) {
          const applied = applyTo(tx, run, event, now)
          if (!applied.ok) return applied
          current = applied.run
          changed = applied.changed
        }
        const set = {
          ...(patch.deployLinks !== undefined && { deployLinks: patch.deployLinks }),
          ...(patch.warnings !== undefined && { warnings: patch.warnings }),
          ...(patch.verification !== undefined && { verification: patch.verification }),
        }
        if (Object.keys(set).length === 0) return { ok: true, run: current, changed }
        const row = tx.update(fixRuns).set(set).where(eq(fixRuns.id, id)).returning().get()
        return { ok: true, run: row ?? current, changed: true }
      })
    },

    /** Stores the ETags of the latest polls. Undefined keeps a value, null clears it. */
    setEtags(id: number, etags: FixRunEtags): FixRunRow | undefined {
      const set = {
        ...(etags.run !== undefined && { runEtag: etags.run }),
        ...(etags.pr !== undefined && { prEtag: etags.pr }),
        ...(etags.checks !== undefined && { checksEtag: etags.checks }),
      }
      if (Object.keys(set).length === 0) return get(id)
      return db.update(fixRuns).set(set).where(eq(fixRuns.id, id)).returning().get()
    },

    /** Stores the runner's result once read and validated (the state is left to applyEvent). */
    setResult(id: number, result: FixResultV1): FixRunRow | undefined {
      return db.update(fixRuns).set({ result }).where(eq(fixRuns.id, id)).returning().get()
    },

    /**
     * Runs in one of `states` that ended at or after `since`, oldest first: the ended runs
     * polling still looks at, so a reopened PR or a re-run workflow is noticed.
     */
    listEndedSince(since: Date, states: readonly FixRunState[]): FixRunRow[] {
      if (states.length === 0) return []
      return db
        .select()
        .from(fixRuns)
        .where(and(inArray(fixRuns.state, [...states]), gte(fixRuns.endedAt, since)))
        .orderBy(fixRuns.id)
        .all()
    },

    /** A repo's runs, newest first, optionally of one kind. */
    listByRepo(repoId: number, options: { kind?: FixRunKind; limit?: number } = {}): FixRunRow[] {
      const where = options.kind
        ? and(eq(fixRuns.repoId, repoId), eq(fixRuns.kind, options.kind))
        : eq(fixRuns.repoId, repoId)
      return db
        .select()
        .from(fixRuns)
        .where(where)
        .orderBy(desc(fixRuns.id))
        .limit(options.limit ?? FIX_RUNS_LIST_LIMIT)
        .all()
    },

    /** Every run that has not reached a terminal state, oldest first: what polling follows. */
    listActive(): FixRunRow[] {
      return db
        .select()
        .from(fixRuns)
        .where(notInArray(fixRuns.state, TERMINAL))
        .orderBy(fixRuns.id)
        .all()
    },

    /** The newest run of a repo and kind. */
    latest(repoId: number, kind: FixRunKind): FixRunRow | undefined {
      return db
        .select()
        .from(fixRuns)
        .where(and(eq(fixRuns.repoId, repoId), eq(fixRuns.kind, kind)))
        .orderBy(desc(fixRuns.id))
        .limit(1)
        .get()
    },

    /** The newest run of every repo that has one, of one kind. */
    latestPerRepo(kind: FixRunKind): FixRunRow[] {
      const latest = db
        .select({ id: sql<number>`max(${fixRuns.id})` })
        .from(fixRuns)
        .where(eq(fixRuns.kind, kind))
        .groupBy(fixRuns.repoId)
        .all()
        .map((r) => r.id)
      if (latest.length === 0) return []
      return db.select().from(fixRuns).where(inArray(fixRuns.id, latest)).all()
    },

    /**
     * The run that recorded PR `prNumber` as closed without merging before the run `before`
     * was created. When there is one, the dispatch of `before` went through the reopen question
     * (decision 10 of the runner design), so a fresh PR may replace the closed one.
     */
    closedUnmergedPr(
      repoId: number,
      kind: FixRunKind,
      prNumber: number,
      before: { id: number; createdAt: Date },
    ): FixRunRow | undefined {
      return db
        .select()
        .from(fixRuns)
        .where(
          and(
            eq(fixRuns.repoId, repoId),
            eq(fixRuns.kind, kind),
            eq(fixRuns.prNumber, prNumber),
            eq(fixRuns.state, 'closed_unmerged'),
            lt(fixRuns.id, before.id),
            lte(fixRuns.closedAt, before.createdAt),
          ),
        )
        .orderBy(desc(fixRuns.id))
        .limit(1)
        .get()
    },

    /**
     * The repo's last fix PR of this kind when it was closed without merging, so the UI asks
     * before dispatching again (decision 10 of the runner design). Undefined when the last PR
     * is open, merged, or there never was one.
     */
    closedUnmergedPrevious(repoId: number, kind: FixRunKind): FixRunRow | undefined {
      const last = db
        .select()
        .from(fixRuns)
        .where(and(eq(fixRuns.repoId, repoId), eq(fixRuns.kind, kind), isNotNull(fixRuns.prNumber)))
        .orderBy(desc(fixRuns.id))
        .limit(1)
        .get()
      return last?.state === 'closed_unmerged' ? last : undefined
    },
  }
}
