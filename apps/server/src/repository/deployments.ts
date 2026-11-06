import type { DeploymentRecord } from '@hinomi/shared'
import { and, asc, eq, exists, notExists, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  deploymentRepoOverrides,
  deployments,
  type DeploymentRepoOverrideRow,
  type DeploymentRow,
  type NewDeploymentRow,
} from '../db/schema.js'

/** What a deployment source reports for one deployment on each sync. */
export type UpsertDeploymentInput = Omit<
  NewDeploymentRow,
  'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt'
>

/**
 * Maps a normalised deployment record (see packages/shared sources) to the
 * upsert input. `repoId` is the automatically mapped repo, null when the
 * record has no repo or it is not known yet.
 */
export function deploymentInputFromRecord(
  record: DeploymentRecord,
  sourceId: number,
  repoId: number | null = null,
): UpsertDeploymentInput {
  const lastDeployedAt = record.lastDeployAt === null ? null : new Date(record.lastDeployAt)
  return {
    sourceId,
    externalId: record.externalId,
    kind: record.kind,
    name: record.name,
    domains: record.domains,
    reach: record.isPublic ? 'public' : 'internal',
    server: record.server,
    status: record.status,
    image: record.image,
    gitRepository: record.repo,
    gitBranch: record.branch,
    watchPaths: record.watchPaths,
    repoId,
    lastDeployedAt:
      lastDeployedAt && !Number.isNaN(lastDeployedAt.getTime()) ? lastDeployedAt : null,
  }
}

export type DeploymentsRepository = ReturnType<typeof createDeploymentsRepository>

export function createDeploymentsRepository(db: Db) {
  const hasOverride = (deploymentId: typeof deployments.id) =>
    db
      .select({ one: sql`1` })
      .from(deploymentRepoOverrides)
      .where(eq(deploymentRepoOverrides.deploymentId, deploymentId))

  return {
    get(id: number): DeploymentRow | undefined {
      return db.select().from(deployments).where(eq(deployments.id, id)).get()
    },

    list(): DeploymentRow[] {
      return db.select().from(deployments).orderBy(asc(deployments.name)).all()
    },

    listBySource(sourceId: number): DeploymentRow[] {
      return db
        .select()
        .from(deployments)
        .where(eq(deployments.sourceId, sourceId))
        .orderBy(asc(deployments.name))
        .all()
    },

    /**
     * Inserts or updates a deployment by (sourceId, externalId) and bumps
     * lastSeenAt. firstSeenAt is kept from the first sync.
     */
    upsert(input: UpsertDeploymentInput, seenAt: Date = new Date()): DeploymentRow {
      return db
        .insert(deployments)
        .values({ ...input, firstSeenAt: seenAt, lastSeenAt: seenAt })
        .onConflictDoUpdate({
          target: [deployments.sourceId, deployments.externalId],
          set: { ...input, lastSeenAt: seenAt, updatedAt: new Date() },
        })
        .returning()
        .get()
    },

    /**
     * Deletes the deployments of a source that the last sync did not report.
     * Returns how many were removed.
     */
    removeMissing(sourceId: number, keepExternalIds: string[]): number {
      const where =
        keepExternalIds.length === 0
          ? eq(deployments.sourceId, sourceId)
          : and(
              eq(deployments.sourceId, sourceId),
              notInArray(deployments.externalId, keepExternalIds),
            )
      return db.delete(deployments).where(where).run().changes
    },

    /** Sets the automatically mapped repo (from the git repository field). */
    setAutoRepo(id: number, repoId: number | null): void {
      db.update(deployments).set({ repoId }).where(eq(deployments.id, id)).run()
    },

    addRepoOverride(deploymentId: number, repoId: number, note?: string): void {
      db.insert(deploymentRepoOverrides)
        .values({ deploymentId, repoId, note: note ?? null })
        .onConflictDoUpdate({
          target: [deploymentRepoOverrides.deploymentId, deploymentRepoOverrides.repoId],
          set: { note: note ?? null },
        })
        .run()
    },

    removeRepoOverride(deploymentId: number, repoId: number): boolean {
      return (
        db
          .delete(deploymentRepoOverrides)
          .where(
            and(
              eq(deploymentRepoOverrides.deploymentId, deploymentId),
              eq(deploymentRepoOverrides.repoId, repoId),
            ),
          )
          .run().changes > 0
      )
    },

    listRepoOverrides(deploymentId?: number): DeploymentRepoOverrideRow[] {
      const query = db.select().from(deploymentRepoOverrides)
      return deploymentId === undefined
        ? query.all()
        : query.where(eq(deploymentRepoOverrides.deploymentId, deploymentId)).all()
    },

    /** Repos a deployment runs: its overrides when it has any, otherwise the automatic repo. */
    effectiveRepoIds(deploymentId: number): number[] {
      const overrides = db
        .select({ repoId: deploymentRepoOverrides.repoId })
        .from(deploymentRepoOverrides)
        .where(eq(deploymentRepoOverrides.deploymentId, deploymentId))
        .all()
      if (overrides.length > 0) return overrides.map((o) => o.repoId)
      const row = db
        .select({ repoId: deployments.repoId })
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .get()
      return row?.repoId == null ? [] : [row.repoId]
    },

    /** Deployments that run a repo, honouring overrides the same way as effectiveRepoIds. */
    listByRepo(repoId: number): DeploymentRow[] {
      return db
        .select()
        .from(deployments)
        .where(
          or(
            exists(
              db
                .select({ one: sql`1` })
                .from(deploymentRepoOverrides)
                .where(
                  and(
                    eq(deploymentRepoOverrides.deploymentId, deployments.id),
                    eq(deploymentRepoOverrides.repoId, repoId),
                  ),
                ),
            ),
            and(eq(deployments.repoId, repoId), notExists(hasOverride(deployments.id))),
          ),
        )
        .orderBy(asc(deployments.name))
        .all()
    },
  }
}
