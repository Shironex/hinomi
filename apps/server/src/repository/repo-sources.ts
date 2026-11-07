import { and, asc, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { repoSources, repos, sources, type RepoRow, type RepoSourceRow } from '../db/schema.js'
import type { Source, SourcesRepository } from './sources.js'

// Which GitHub source reads and fixes each repo. Scans record every source that saw a repo
// (repo_sources) and pick one as its reader (repos.source_id); a reader picked by hand
// (repos.source_override_id) wins while it is enabled. See scan/ownership.ts for the rule.

/** How a repo's GitHub source was chosen. */
export type RepoSourceMode = 'override' | 'auto' | 'fallback' | 'none'

export interface RepoSourceResolution {
  /** The enabled GitHub source with a credential to use for the repo, or null. */
  source: Source | null
  /**
   * override: picked by hand. auto: the scan's choice. fallback: the repo has no reader yet and
   * only one GitHub source is connected, so that one is used. none: nothing can read the repo.
   */
  mode: RepoSourceMode
}

/** A GitHub source a repo can be read through: enabled and holding a credential. */
export function isUsableGithubSource(source: Source): boolean {
  return source.kind === 'github' && source.enabled && source.hasToken
}

/** The repo's GitHub source: the override, else the scan's choice, else the only one there is. */
export function resolveRepoSource(
  sourcesRepo: Pick<SourcesRepository, 'listByKind'>,
  repo: Pick<RepoRow, 'sourceId' | 'sourceOverrideId'>,
): RepoSourceResolution {
  const usable = sourcesRepo.listByKind('github').filter(isUsableGithubSource)
  const byId = (id: number | null) => (id === null ? undefined : usable.find((s) => s.id === id))
  const override = byId(repo.sourceOverrideId)
  if (override) return { source: override, mode: 'override' }
  const chosen = byId(repo.sourceId)
  if (chosen) return { source: chosen, mode: 'auto' }
  if (repo.sourceId === null && usable.length === 1) {
    return { source: usable[0]!, mode: 'fallback' }
  }
  return { source: null, mode: 'none' }
}

/**
 * Moves every repo read through `sourceId` to the next source that saw it (one that could read
 * its alerts first, then the lowest id), or leaves it with no reader. Findings, plans and runs
 * of the repo are kept either way.
 */
export function releaseSource(db: Db, sourceId: number): void {
  const owned = db.select({ id: repos.id }).from(repos).where(eq(repos.sourceId, sourceId)).all()
  for (const { id } of owned) {
    const next = db
      .select({ sourceId: repoSources.sourceId })
      .from(repoSources)
      .innerJoin(sources, eq(sources.id, repoSources.sourceId))
      .where(
        and(
          eq(repoSources.repoId, id),
          ne(repoSources.sourceId, sourceId),
          eq(sources.kind, 'github'),
          eq(sources.enabled, true),
          isNotNull(sources.tokenEncrypted),
        ),
      )
      .orderBy(sql`coalesce(${repoSources.alertsReadable}, 0) desc`, asc(repoSources.sourceId))
      .limit(1)
      .get()
    db.update(repos)
      .set({ sourceId: next?.sourceId ?? null })
      .where(eq(repos.id, id))
      .run()
  }
}

export type RepoSourcesRepository = ReturnType<typeof createRepoSourcesRepository>

export function createRepoSourcesRepository(db: Db) {
  return {
    /** The sources that saw the repo, lowest id first. */
    seenBy(repoId: number): RepoSourceRow[] {
      return db
        .select()
        .from(repoSources)
        .where(eq(repoSources.repoId, repoId))
        .orderBy(asc(repoSources.sourceId))
        .all()
    },

    /** Records that the source can read the repo. */
    record(repoId: number, sourceId: number, alertsReadable: boolean | null, at: Date): void {
      db.insert(repoSources)
        .values({ repoId, sourceId, alertsReadable, lastSeenAt: at })
        .onConflictDoUpdate({
          target: [repoSources.repoId, repoSources.sourceId],
          set: { alertsReadable, lastSeenAt: at },
        })
        .run()
    },

    /** Records that these sources cannot see the repo (any more). */
    forget(repoId: number, sourceIds: readonly number[]): void {
      if (sourceIds.length === 0) return
      db.delete(repoSources)
        .where(and(eq(repoSources.repoId, repoId), inArray(repoSources.sourceId, [...sourceIds])))
        .run()
    },

    /** Sets the scan's choice of reader; null when no source could read the repo. */
    setOwner(repoId: number, sourceId: number | null): void {
      db.update(repos).set({ sourceId }).where(eq(repos.id, repoId)).run()
    },

    /**
     * Picks the repo's source by hand; null goes back to the scan's choice. Undefined when the
     * repo does not exist.
     */
    setOverride(repoId: number, sourceId: number | null): RepoRow | undefined {
      return db
        .update(repos)
        .set({ sourceOverrideId: sourceId })
        .where(eq(repos.id, repoId))
        .returning()
        .get()
    },

    /** How many repos each source reads (a source picked by hand counts for the repo), by id. */
    repoCounts(): Map<number, number> {
      const reader = sql<number | null>`coalesce(${repos.sourceOverrideId}, ${repos.sourceId})`
      const rows = db
        .select({ sourceId: reader, n: count() })
        .from(repos)
        .where(sql`${reader} is not null`)
        .groupBy(reader)
        .all()
      return new Map(rows.flatMap((r) => (r.sourceId === null ? [] : [[r.sourceId, r.n]])))
    },
  }
}
