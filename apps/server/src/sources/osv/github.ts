import { mapLimit } from './client.js'
import { isLockfileName } from './lockfiles/index.js'

export interface FetchedLockfile {
  /** Repo relative path, e.g. `pnpm-lock.yaml` or `apps/web/yarn.lock`. */
  path: string
  text: string
  /** The sibling package.json, fetched only for yarn.lock (needed for its scope). */
  packageJson?: string
}

export interface FetchLockfilesOptions {
  fetch?: typeof fetch
  apiUrl?: string
  timeoutMs?: number
}

/** Folders whose direct children are searched for lockfiles too. */
const MONOREPO_FOLDERS = ['apps', 'packages']

interface ContentEntry {
  name: string
  path: string
  type: string
}

export class GitHubContentsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GitHubContentsError'
  }
}

/**
 * Finds lockfiles at the repo root and one level inside `apps/` and
 * `packages/`, and downloads their text through the GitHub contents API.
 * `token` may be null for public repos.
 */
export async function fetchLockfiles(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
  options: FetchLockfilesOptions = {},
): Promise<FetchedLockfile[]> {
  const doFetch = options.fetch ?? fetch
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? 20_000

  const get = async (path: string, raw: boolean): Promise<Response | null> => {
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const url = `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
    const res = await doFetch(url, {
      headers: {
        // The raw media type serves files up to 100 MB; the JSON form stops at 1 MB.
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new GitHubContentsError(
        `GitHub contents ${path || '/'} answered ${res.status}`,
        res.status,
      )
    }
    return res
  }

  const list = async (path: string): Promise<ContentEntry[]> => {
    const res = await get(path, false)
    if (!res) return []
    const body: unknown = await res.json()
    return Array.isArray(body) ? (body as ContentEntry[]) : []
  }

  const root = await list('')
  const folders = root.filter((e) => e.type === 'dir' && MONOREPO_FOLDERS.includes(e.name))
  const children = (await mapLimit(folders, 4, (f) => list(f.path)))
    .flat()
    .filter((e) => e.type === 'dir')
  const nested = (await mapLimit(children, 4, (c) => list(c.path))).flat()

  const listed = [...root, ...nested]
  const lockfiles = listed.filter((e) => e.type === 'file' && isLockfileName(e.name))
  const files = new Set(listed.filter((e) => e.type === 'file').map((e) => e.path))

  const readText = async (path: string) => (await get(path, true))?.text() ?? null

  const fetched = await mapLimit(lockfiles, 4, async (entry): Promise<FetchedLockfile | null> => {
    const text = await readText(entry.path)
    if (text === null) return null
    const result: FetchedLockfile = { path: entry.path, text }
    if (entry.name === 'yarn.lock') {
      const dir = entry.path.slice(0, entry.path.length - entry.name.length)
      const manifest = `${dir}package.json`
      if (files.has(manifest)) {
        const pkg = await readText(manifest)
        if (pkg !== null) result.packageJson = pkg
      }
    }
    return result
  })
  return fetched.filter((f): f is FetchedLockfile => f !== null)
}
