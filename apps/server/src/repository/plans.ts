import { FIX_RUN_TERMINAL_STATES, type FixPlan } from '@hinomi/shared'
import { and, desc, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { fixPlans, fixRuns, type FixPlanRow } from '../db/schema.js'

/**
 * Plans kept per repo; older ones are dropped when a scan saves a new one, except plans an
 * unfinished fix run still applies.
 */
export const FIX_PLANS_KEPT_PER_REPO = 20

export type FixPlansRepository = ReturnType<typeof createFixPlansRepository>

export function createFixPlansRepository(db: Db) {
  return {
    /**
     * Stores the plan a scan built for a repo (replacing one the same scan saved before) and
     * drops the repo's plans beyond FIX_PLANS_KEPT_PER_REPO, oldest first. Plans of fix runs that
     * have not ended are kept.
     */
    save(plan: FixPlan, createdAt: Date): FixPlanRow {
      return db.transaction((tx) => {
        const counts = {
          version: plan.version,
          plan,
          findingsCleared: plan.summary.findings.cleared,
          safeSteps: plan.summary.steps.safe,
          riskySteps: plan.summary.steps.risky,
          unfixed: plan.summary.unfixed,
          createdAt,
        }
        const row = tx
          .insert(fixPlans)
          .values({ repoId: plan.repo.id, scanRunId: plan.scanRunId, ...counts })
          .onConflictDoUpdate({ target: [fixPlans.repoId, fixPlans.scanRunId], set: counts })
          .returning()
          .get()
        const keep = tx
          .select({ scanRunId: fixPlans.scanRunId })
          .from(fixPlans)
          .where(eq(fixPlans.repoId, plan.repo.id))
          .orderBy(desc(fixPlans.scanRunId))
          .limit(1)
          .offset(FIX_PLANS_KEPT_PER_REPO - 1)
          .get()
        if (keep) {
          const inUse = tx
            .select({ id: fixRuns.fixPlanId })
            .from(fixRuns)
            .where(
              and(
                isNotNull(fixRuns.fixPlanId),
                notInArray(fixRuns.state, [...FIX_RUN_TERMINAL_STATES]),
              ),
            )
          tx.delete(fixPlans)
            .where(
              and(
                eq(fixPlans.repoId, plan.repo.id),
                lt(fixPlans.scanRunId, keep.scanRunId),
                notInArray(fixPlans.id, inUse),
              ),
            )
            .run()
        }
        return row
      })
    },

    /** The repo's plan from one scan, or its latest when `scanRunId` is left out. */
    forRepo(repoId: number, scanRunId?: number): FixPlanRow | undefined {
      const where =
        scanRunId === undefined
          ? eq(fixPlans.repoId, repoId)
          : and(eq(fixPlans.repoId, repoId), eq(fixPlans.scanRunId, scanRunId))
      return db
        .select()
        .from(fixPlans)
        .where(where)
        .orderBy(desc(fixPlans.scanRunId))
        .limit(1)
        .get()
    },

    /** The latest plan of every repo that has one. */
    latestPerRepo(): FixPlanRow[] {
      const latest = db
        .select({ id: sql<number>`max(${fixPlans.id})` })
        .from(fixPlans)
        .groupBy(fixPlans.repoId)
        .all()
        .map((r) => r.id)
      if (latest.length === 0) return []
      return db.select().from(fixPlans).where(inArray(fixPlans.id, latest)).all()
    },
  }
}
