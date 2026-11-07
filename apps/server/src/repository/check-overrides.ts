import { currentTime, type OverridableCheck } from '@hinomi/shared'
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { checkOverrides, type CheckOverrideRow } from '../db/schema.js'

/** The subject an override turns a check off for. */
export type OverrideSubject = { deploymentId: number } | { repoId: number }

export interface ListCheckOverridesFilter {
  checks?: readonly OverridableCheck[]
  deploymentIds?: readonly number[]
  repoIds?: readonly number[]
}

export type CheckOverridesRepository = ReturnType<typeof createCheckOverridesRepository>

function subjectWhere(subject: OverrideSubject): SQL {
  return 'deploymentId' in subject
    ? eq(checkOverrides.deploymentId, subject.deploymentId)
    : eq(checkOverrides.repoId, subject.repoId)
}

/** Storage of check overrides (see checkOverrides in db/schema.ts). */
export function createCheckOverridesRepository(db: Db) {
  function get(id: number): CheckOverrideRow | undefined {
    return db.select().from(checkOverrides).where(eq(checkOverrides.id, id)).get()
  }

  function find(check: OverridableCheck, subject: OverrideSubject): CheckOverrideRow | undefined {
    return db
      .select()
      .from(checkOverrides)
      .where(and(eq(checkOverrides.check, check), subjectWhere(subject)))
      .get()
  }

  return {
    get,
    find,

    /** Overrides matching every given filter (a filter with an empty list matches nothing). */
    list(filter: ListCheckOverridesFilter = {}): CheckOverrideRow[] {
      const conditions: SQL[] = []
      if (filter.checks) conditions.push(inArray(checkOverrides.check, [...filter.checks]))
      if (filter.deploymentIds) {
        conditions.push(inArray(checkOverrides.deploymentId, [...filter.deploymentIds]))
      }
      if (filter.repoIds) conditions.push(inArray(checkOverrides.repoId, [...filter.repoIds]))
      return db
        .select()
        .from(checkOverrides)
        .where(and(...conditions))
        .orderBy(asc(checkOverrides.id))
        .all()
    },

    /** Turns a check off for one subject. Null when it already is off for that subject. */
    create(
      input: { check: OverridableCheck; subject: OverrideSubject; reason: string },
      at: Date = currentTime(),
    ): CheckOverrideRow | null {
      return db.transaction(() => {
        if (find(input.check, input.subject)) return null
        return db
          .insert(checkOverrides)
          .values({
            check: input.check,
            deploymentId: 'deploymentId' in input.subject ? input.subject.deploymentId : null,
            repoId: 'repoId' in input.subject ? input.subject.repoId : null,
            reason: input.reason,
            createdAt: at,
            updatedAt: at,
          })
          .returning()
          .get()
      })
    },

    updateReason(
      id: number,
      reason: string,
      at: Date = currentTime(),
    ): CheckOverrideRow | undefined {
      return db
        .update(checkOverrides)
        .set({ reason, updatedAt: at })
        .where(eq(checkOverrides.id, id))
        .returning()
        .get()
    },

    /** Removes an override; returns the removed row, undefined when there was none. */
    remove(id: number): CheckOverrideRow | undefined {
      return db.delete(checkOverrides).where(eq(checkOverrides.id, id)).returning().get()
    },
  }
}
