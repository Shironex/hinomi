import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { repos, type RepoRow } from '../db/schema.js'
import { currentTime, type FixRunnerKind, type RunnerMajorsAgent } from '@hinomi/shared'

export interface UpsertRepoInput {
  owner: string
  name: string
  defaultBranch?: string | null
  archived?: boolean
  alertsEnabled?: boolean | null
}

export interface RepoRunnerPatch {
  enabled?: boolean
  workflow?: string | null
  majorsAgent?: RunnerMajorsAgent
  kind?: FixRunnerKind
}

/** GitHub owner and repo names are case-insensitive; rows store them lowercased. */
export function normalizeRepoName(owner: string, name: string): { owner: string; name: string } {
  return { owner: owner.trim().toLowerCase(), name: name.trim().toLowerCase() }
}

export type ReposRepository = ReturnType<typeof createReposRepository>

export function createReposRepository(db: Db) {
  return {
    get(id: number): RepoRow | undefined {
      return db.select().from(repos).where(eq(repos.id, id)).get()
    },

    getByName(owner: string, name: string): RepoRow | undefined {
      const key = normalizeRepoName(owner, name)
      return db
        .select()
        .from(repos)
        .where(and(eq(repos.owner, key.owner), eq(repos.name, key.name)))
        .get()
    },

    list(): RepoRow[] {
      return db.select().from(repos).orderBy(asc(repos.owner), asc(repos.name)).all()
    },

    /**
     * Inserts the repo or updates it by owner/name. Only the fields that are
     * given are changed on an existing row.
     */
    upsert(input: UpsertRepoInput): RepoRow {
      const key = normalizeRepoName(input.owner, input.name)
      const fields = {
        ...(input.defaultBranch !== undefined && { defaultBranch: input.defaultBranch }),
        ...(input.archived !== undefined && { archived: input.archived }),
        ...(input.alertsEnabled !== undefined && { alertsEnabled: input.alertsEnabled }),
      }
      return db
        .insert(repos)
        .values({ ...key, ...fields })
        .onConflictDoUpdate({
          target: [repos.owner, repos.name],
          set: { ...fields, updatedAt: currentTime() },
        })
        .returning()
        .get()
    },

    /**
     * Changes the repo's runner settings. Undefined keeps a value; a null workflow goes back to
     * the default file name. Undefined when the repo does not exist.
     */
    setRunner(id: number, patch: RepoRunnerPatch): RepoRow | undefined {
      const set = {
        ...(patch.enabled !== undefined && { runnerEnabled: patch.enabled }),
        ...(patch.workflow !== undefined && { runnerWorkflow: patch.workflow }),
        ...(patch.majorsAgent !== undefined && { runnerMajorsAgent: patch.majorsAgent }),
        ...(patch.kind !== undefined && { runnerKind: patch.kind }),
      }
      if (Object.keys(set).length === 0) {
        return db.select().from(repos).where(eq(repos.id, id)).get()
      }
      return db.update(repos).set(set).where(eq(repos.id, id)).returning().get()
    },

    markScanned(id: number, at: Date = currentTime()): void {
      db.update(repos).set({ lastScannedAt: at }).where(eq(repos.id, id)).run()
    },

    remove(id: number): boolean {
      return db.delete(repos).where(eq(repos.id, id)).run().changes > 0
    },
  }
}
