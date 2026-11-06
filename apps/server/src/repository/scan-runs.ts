import type { ScanRunStatus, ScanTrigger, SourceKind } from '@hinomi/shared'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { scanRuns, type ScanRunRow, type ScanSourceResult } from '../db/schema.js'

export interface FinishScanRunInput {
  status: Exclude<ScanRunStatus, 'running'>
  sourceResults: Partial<Record<SourceKind, ScanSourceResult>>
  findingsOpened?: number
  findingsFixed?: number
  error?: string | null
}

export type ScanRunsRepository = ReturnType<typeof createScanRunsRepository>

export function createScanRunsRepository(db: Db) {
  return {
    get(id: number): ScanRunRow | undefined {
      return db.select().from(scanRuns).where(eq(scanRuns.id, id)).get()
    },

    start(trigger: ScanTrigger, at: Date = new Date()): ScanRunRow {
      return db.insert(scanRuns).values({ trigger, startedAt: at }).returning().get()
    },

    /** Closes a run with its outcome; durationMs is computed from startedAt. */
    finish(id: number, input: FinishScanRunInput, at: Date = new Date()): ScanRunRow | undefined {
      const run = db.select().from(scanRuns).where(eq(scanRuns.id, id)).get()
      if (!run) return undefined
      return db
        .update(scanRuns)
        .set({
          status: input.status,
          sourceResults: input.sourceResults,
          findingsOpened: input.findingsOpened ?? 0,
          findingsFixed: input.findingsFixed ?? 0,
          error: input.error ?? null,
          finishedAt: at,
          durationMs: Math.max(0, at.getTime() - run.startedAt.getTime()),
        })
        .where(eq(scanRuns.id, id))
        .returning()
        .get()
    },

    /** Most recent runs first. */
    list(limit = 50): ScanRunRow[] {
      return db
        .select()
        .from(scanRuns)
        .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
        .limit(limit)
        .all()
    },

    latest(): ScanRunRow | undefined {
      return db
        .select()
        .from(scanRuns)
        .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
        .limit(1)
        .get()
    },

    /** The run still in progress, if any (one scan at a time). */
    running(): ScanRunRow | undefined {
      return db.select().from(scanRuns).where(eq(scanRuns.status, 'running')).limit(1).get()
    },
  }
}
