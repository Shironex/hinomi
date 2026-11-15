import { z } from 'zod'
import type { RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { errorMessage } from './collect.js'
import { RELEASE_CHECK_INTERVAL_MS, type ReleaseScanError } from './releases.js'
import type { ScanSources } from './sources.js'

// Desktop tier candidates while account repos are not scanned (decision of 2026-11-07, see
// docs/design/phase-2.md "Decisions taken"). With the setting off a scan reads only deployed
// repos, so the release step would never see a repo nothing deploys. Instead, once a day, each
// GitHub source's own repo list (`/user/repos` for a token, `/installation/repositories` for an
// app: one request per 100 repos) is read and kept. Every repo on it that nothing deploys is a
// release candidate: it gets the daily latest release check, and its tag is scanned only when
// that release is released (installers, or the tier turned on). Its default branch stays unread.

/** The http_cache entry holding a GitHub source's last repo list, for the release candidates. */
export function releaseCandidatesCacheKey(sourceId: number): string {
  return `github:release:candidates:${sourceId}`
}

const listedSchema = z.array(z.object({ owner: z.string(), name: z.string() }))
type Listed = z.infer<typeof listedSchema>

/** A source's stored repo list and when it was read, or null when none is stored. */
function readStored(
  repositories: Repositories,
  sourceId: number,
): { listed: Listed; fetchedAt: Date } | null {
  const entry = repositories.httpCache.get(releaseCandidatesCacheKey(sourceId))
  if (!entry) return null
  try {
    const parsed = listedSchema.safeParse(JSON.parse(entry.body.toString('utf8')))
    return parsed.success ? { listed: parsed.data, fetchedAt: entry.fetchedAt } : null
  } catch {
    return null
  }
}

export interface ReleaseCandidates {
  /** Repos to hand the release step, in addition to the ones the scan read. */
  repos: RepoRow[]
  /** The GitHub source that checks each candidate's release, by repo id. */
  readers: Map<number, number>
  /** Repo lists read from GitHub this scan. */
  listed: number
  errors: ReleaseScanError[]
}

/**
 * The repos the release step adds while account repos are not scanned: every repo a GitHub
 * source lists (read once a day, kept in http_cache) that is not in `scanned` already. Rows are
 * created for listed repos so the release check has somewhere to live; nothing else reads them.
 * Returns nothing while account repos are scanned (the scan reads them all then). A failed list is
 * an error and the last stored list is used. Never throws.
 */
export async function releaseCandidates(
  repositories: Repositories,
  sources: Pick<ScanSources, 'github' | 'settings'>,
  scanned: readonly RepoRow[],
  now: Date,
): Promise<ReleaseCandidates> {
  const result: ReleaseCandidates = { repos: [], readers: new Map(), listed: 0, errors: [] }
  if (sources.settings.includeAccountRepos) return result
  const skip = new Set(scanned.map((r) => r.id))
  for (const github of sources.github) {
    const stored = readStored(repositories, github.sourceId)
    let listed = stored?.listed ?? []
    const due =
      stored === null || now.getTime() - stored.fetchedAt.getTime() >= RELEASE_CHECK_INTERVAL_MS
    if (due) {
      try {
        const repos = await github.listAccountRepos()
        listed = repos.map((r) => ({ owner: r.owner, name: r.name }))
        repositories.db.transaction(() => {
          for (const r of repos) {
            repositories.repos.upsert({
              owner: r.owner,
              name: r.name,
              archived: r.archived,
              ...(r.defaultBranch && { defaultBranch: r.defaultBranch }),
            })
          }
          repositories.httpCache.put({
            key: releaseCandidatesCacheKey(github.sourceId),
            etag: null,
            lastModified: null,
            fetchedAt: now,
            status: 200,
            body: Buffer.from(JSON.stringify(listed), 'utf8'),
          })
        })
        result.listed++
      } catch (error) {
        result.errors.push({
          source: 'github',
          subject: `${github.name} repo list for releases`,
          error: errorMessage(error),
        })
      }
    }
    for (const entry of listed) {
      const repo = repositories.repos.getByName(entry.owner, entry.name)
      if (!repo || skip.has(repo.id) || result.readers.has(repo.id)) continue
      result.readers.set(repo.id, github.sourceId)
      result.repos.push(repo)
    }
  }
  return result
}
