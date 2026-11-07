import { and, eq, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { advisories, type AdvisoryRow, type NewAdvisoryRow } from '../db/schema.js'
import { currentTime } from '@hinomi/shared'

export type UpsertAdvisoryInput = Omit<NewAdvisoryRow, 'id' | 'createdAt' | 'updatedAt'>

export type AdvisoriesRepository = ReturnType<typeof createAdvisoriesRepository>

export function createAdvisoriesRepository(db: Db) {
  return {
    get(id: number): AdvisoryRow | undefined {
      return db.select().from(advisories).where(eq(advisories.id, id)).get()
    },

    /** Inserts or updates by (advisoryKey, ecosystem, packageName). */
    upsert(input: UpsertAdvisoryInput): AdvisoryRow {
      return db
        .insert(advisories)
        .values(input)
        .onConflictDoUpdate({
          target: [advisories.advisoryKey, advisories.ecosystem, advisories.packageName],
          // Key columns are in `input` too; setting them to the same value is a no-op.
          set: { ...input, updatedAt: currentTime() },
        })
        .returning()
        .get()
    },

    /** Every stored advisory of one package, for the fix plan's target check. */
    forPackage(ecosystem: string, packageName: string): AdvisoryRow[] {
      return db
        .select()
        .from(advisories)
        .where(and(eq(advisories.ecosystem, ecosystem), eq(advisories.packageName, packageName)))
        .all()
    },

    /**
     * Advisories known by an id: the advisory key, the GHSA id, a CVE id or an
     * alias. Used to dedupe OSV results against GitHub ones.
     */
    findByAnyId(id: string): AdvisoryRow[] {
      return db
        .select()
        .from(advisories)
        .where(
          or(
            eq(advisories.advisoryKey, id),
            eq(advisories.ghsaId, id),
            sql`exists (select 1 from json_each(${advisories.cveIds}) where value = ${id})`,
            sql`exists (select 1 from json_each(${advisories.aliases}) where value = ${id})`,
          ),
        )
        .all()
    },
  }
}
