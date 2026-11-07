import type { RuntimePinRecord, StoredRuntimePin } from '@hinomi/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { runtimePins, type RuntimePinRow } from '../db/schema.js'

export type RuntimePinsRepository = ReturnType<typeof createRuntimePinsRepository>

function toPin(row: RuntimePinRow): StoredRuntimePin {
  return {
    id: row.id,
    repoId: row.repoId,
    ref: row.ref,
    runtime: row.runtime,
    source: row.source,
    path: row.path,
    line: row.line,
    raw: row.raw,
    lineName: row.lineName,
    floating: row.floating,
    kind: row.kind,
    version: row.version,
    scope: row.scope,
    job: row.job,
    stage: row.stage,
    finalStage: row.finalStage,
    scannedAt: row.scannedAt,
  }
}

/** The runtime pins read from each repo's files (docs/design/phase-2.md section 5). */
export function createRuntimePinsRepository(db: Db) {
  return {
    /** Pins of a repo at a ref, in file order; every ref when `ref` is omitted. */
    list(repoId: number, ref?: string): StoredRuntimePin[] {
      const where =
        ref === undefined
          ? eq(runtimePins.repoId, repoId)
          : and(eq(runtimePins.repoId, repoId), eq(runtimePins.ref, ref))
      return db
        .select()
        .from(runtimePins)
        .where(where)
        .orderBy(asc(runtimePins.path), asc(runtimePins.line), asc(runtimePins.id))
        .all()
        .map(toPin)
    },

    /**
     * Stores what a scan read: replaces every pin of the repo at `ref`, so a file that lost its
     * pin loses the row. Other refs of the repo are left alone.
     */
    replace(repoId: number, ref: string, pins: readonly RuntimePinRecord[], scannedAt: Date): void {
      db.transaction((tx) => {
        tx.delete(runtimePins)
          .where(and(eq(runtimePins.repoId, repoId), eq(runtimePins.ref, ref)))
          .run()
        for (const pin of pins) {
          tx.insert(runtimePins)
            .values({ ...pin, repoId, ref, scannedAt })
            .run()
        }
      })
    },
  }
}
