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

/** What listing a repo folder said. */
export type RepoDirRead =
  | { status: 'ok'; paths: string[] }
  /** The folder does not exist at that ref. */
  | { status: 'missing' }
  | { status: 'no_source' }
  | { status: 'error'; reason: string }

export interface ReadFileOptions {
  /**
   * Keep a read at a branch or tag for this long (a sha is kept for good anyway). Without it a
   * branch is read once per scan.
   */
  maxAgeMs?: number
}

/** Reads files of the repos in a scan (a Dockerfile at a commit), cached where that is safe. */
export interface RepoFileReader {
  read(repo: RepoRow, path: string, ref: string, options?: ReadFileOptions): Promise<RepoFileRead>
  /** The file paths directly inside a folder of the repo (`.github/workflows`). Never cached. */
  list(repo: RepoRow, dir: string, ref: string): Promise<RepoDirRead>
}

const FULL_SHA = /^[0-9a-f]{40}$/

export interface RepoFileReaderOptions {
  sources: Pick<ScanSources, 'github' | 'readRepoFile' | 'listRepoDir'>
  httpCache: HttpCacheRepository
  /** This scan's results, for the GitHub source that read each repo. */
  scans: ReadonlyMap<number, RepoScan>
  now: () => Date
}

/**
 * Reads through the repo's own GitHub source: the one this scan used for it, else the one
 * stored on the repo (`repos.source_id`, a manual pick wins). A file at a full commit sha never
 * changes, so its text (or its absence) is kept in the http cache and a deploy that did not
 * change costs no GitHub call. A branch is read every scan unless the caller gives `maxAgeMs`
 * (an action tag). Within one scan the same read is made once.
 */
export function createRepoFileReader(options: RepoFileReaderOptions): RepoFileReader {
  const { sources, httpCache, scans, now } = options
  const inFlight = new Map<string, Promise<RepoFileRead>>()

  function sourceOf(repo: RepoRow): number | null {
    const sourceId = scans.get(repo.id)?.sourceId ?? repo.sourceOverrideId ?? repo.sourceId
    return sourceId !== null &&
      sourceId !== undefined &&
      sources.github.some((g) => g.sourceId === sourceId)
      ? sourceId
      : null
  }

  async function fetchFile(
    repo: RepoRow,
    path: string,
    ref: string,
    maxAgeMs: number | undefined,
  ): Promise<RepoFileRead> {
    const sourceId = sourceOf(repo)
    if (sourceId === null || !sources.readRepoFile) return { status: 'no_source' }
    const pinned = FULL_SHA.test(ref)
    const cacheable = pinned || maxAgeMs !== undefined
    const key = `repo-file:${repo.owner}/${repo.name}@${ref}:${path}`
    if (cacheable) {
      const hit = httpCache.get(key)
      if (hit && (pinned || now().getTime() - hit.fetchedAt.getTime() < (maxAgeMs ?? 0))) {
        return hit.status === 404
          ? { status: 'missing' }
          : { status: 'ok', text: hit.body.toString('utf8') }
      }
    }
    try {
      const text = await sources.readRepoFile(repo.owner, repo.name, path, ref, sourceId)
      if (cacheable) {
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
    read(repo, path, ref, readOptions = {}) {
      // The repo's name, not its id: a guard may read another repo through this repo's source.
      const key = `${repo.owner}/${repo.name}@${ref}:${path}`
      let pending = inFlight.get(key)
      if (!pending) {
        pending = fetchFile(repo, path, ref, readOptions.maxAgeMs)
        inFlight.set(key, pending)
      }
      return pending
    },
    async list(repo, dir, ref) {
      const sourceId = sourceOf(repo)
      if (sourceId === null || !sources.listRepoDir) return { status: 'no_source' }
      try {
        const paths = await sources.listRepoDir(repo.owner, repo.name, dir, ref, sourceId)
        return paths === null ? { status: 'missing' } : { status: 'ok', paths }
      } catch (error) {
        return { status: 'error', reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
