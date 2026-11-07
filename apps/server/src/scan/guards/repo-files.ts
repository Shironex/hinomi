import type { RepoRow } from '../../db/schema.js'
import type { HttpCacheRepository } from '../../repository/index.js'
import type { RepoScan } from '../collect.js'
import type { ScanSources } from '../sources.js'

/** What reading a repo file said. */
export type RepoFileRead =
  | { status: 'ok'; text: string }
  /** The file does not exist at that ref. */
  | { status: 'missing' }
  /** No GitHub source can read the repo. */
  | { status: 'no_source' }
  /** The read failed (rate limit, network, a file too large). Try again next scan. */
  | { status: 'error'; reason: string }

/** Reads files of the repos in a scan (a Dockerfile at a commit), cached where that is safe. */
export interface RepoFileReader {
  read(repo: RepoRow, path: string, ref: string): Promise<RepoFileRead>
}

const FULL_SHA = /^[0-9a-f]{40}$/

export interface RepoFileReaderOptions {
  sources: Pick<ScanSources, 'github' | 'readRepoFile'>
  httpCache: HttpCacheRepository
  /** This scan's results, for the GitHub source that read each repo. */
  scans: ReadonlyMap<number, RepoScan>
  now: () => Date
}

/**
 * Reads through the repo's own GitHub source: the one this scan used for it, else the one
 * stored on the repo (`repos.source_id`, a manual pick wins). A file at a full commit sha never
 * changes, so its text (or its absence) is kept in the http cache and a deploy that did not
 * change costs no GitHub call. A branch is read every scan. Within one scan the same read is
 * made once.
 */
export function createRepoFileReader(options: RepoFileReaderOptions): RepoFileReader {
  const { sources, httpCache, scans, now } = options
  const inFlight = new Map<string, Promise<RepoFileRead>>()

  async function fetchFile(repo: RepoRow, path: string, ref: string): Promise<RepoFileRead> {
    const sourceId = scans.get(repo.id)?.sourceId ?? repo.sourceOverrideId ?? repo.sourceId
    if (
      sourceId === null ||
      sourceId === undefined ||
      !sources.readRepoFile ||
      !sources.github.some((g) => g.sourceId === sourceId)
    ) {
      return { status: 'no_source' }
    }
    const pinned = FULL_SHA.test(ref)
    const key = `repo-file:${repo.owner}/${repo.name}@${ref}:${path}`
    if (pinned) {
      const hit = httpCache.get(key)
      if (hit) {
        return hit.status === 404
          ? { status: 'missing' }
          : { status: 'ok', text: hit.body.toString('utf8') }
      }
    }
    try {
      const text = await sources.readRepoFile(repo.owner, repo.name, path, ref, sourceId)
      if (pinned) {
        httpCache.put({
          key,
          etag: null,
          lastModified: null,
          fetchedAt: now(),
          status: text === null ? 404 : 200,
          body: Buffer.from(text ?? '', 'utf8'),
        })
      }
      return text === null ? { status: 'missing' } : { status: 'ok', text }
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    read(repo, path, ref) {
      const key = `${repo.id}@${ref}:${path}`
      let pending = inFlight.get(key)
      if (!pending) {
        pending = fetchFile(repo, path, ref)
        inFlight.set(key, pending)
      }
      return pending
    },
  }
}
