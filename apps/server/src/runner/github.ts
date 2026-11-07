import {
  isUsableGithubSource,
  resolveRepoSource,
  type Repositories,
  type Source,
} from '../repository/index.js'
import {
  createGithubSourceFromConfig,
  type GithubClientOptions,
  type GithubSource,
} from '../sources/github/index.js'

export interface RunnerGithubOptions {
  fetch?: typeof fetch
  /** Client tuning, such as a short rate limit wait for background polling. */
  client?: Pick<GithubClientOptions, 'maxWaitMs' | 'maxRetries' | 'timeoutMs' | 'now'>
}

/** The GitHub source the runner talks through for one repo, or why there is none. */
export type RunnerGithub = { ok: true; source: GithubSource } | { ok: false; message: string }

/** The GitHub source of a repo, opened on demand: `(repoId) => RunnerGithub`. */
export type RunnerGithubFor = (repoId: number) => RunnerGithub

/** Why a repo has no GitHub source to use. */
function noSource(repositories: Repositories, repoId: number): RunnerGithub {
  const repo = repositories.repos.get(repoId)
  if (!repo) return { ok: false, message: 'The repo was removed.' }
  const usable = repositories.sources.listByKind('github').some(isUsableGithubSource)
  if (!usable) return { ok: false, message: 'Connect a GitHub source first.' }
  return {
    ok: false,
    message: `No connected GitHub source can read ${repo.owner}/${repo.name}. Rescan, or pick its source in the repo settings.`,
  }
}

/** The repo's GitHub source row: the override, the scan's choice, or the only one there is. */
function sourceRowOf(repositories: Repositories, repoId: number): Source | null {
  const repo = repositories.repos.get(repoId)
  return repo ? resolveRepoSource(repositories.sources, repo).source : null
}

/** Binds a source row to its decrypted secret. */
export function openGithubSource(
  repositories: Repositories,
  row: Source,
  options: RunnerGithubOptions = {},
): RunnerGithub {
  let secret: string | null
  try {
    secret = repositories.sources.getToken(row.id)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `The GitHub credential could not be read: ${reason}` }
  }
  if (!secret) return { ok: false, message: `GitHub source "${row.name}" has no credential.` }
  try {
    const source = createGithubSourceFromConfig(row, secret, {
      ...options.client,
      ...(options.fetch && { fetch: options.fetch }),
    })
    return { ok: true, source }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The GitHub source that reads the repo (see repository/repo-sources.ts), the same one scans
 * use for it, bound to its decrypted secret. Everything the runner does for a repo (dispatch,
 * setup PR, publisher, tracker, permissions) goes through it.
 */
export function openRunnerGithub(
  repositories: Repositories,
  repoId: number,
  options: RunnerGithubOptions = {},
): RunnerGithub {
  const row = sourceRowOf(repositories, repoId)
  if (!row) return noSource(repositories, repoId)
  return openGithubSource(repositories, row, options)
}

/**
 * openRunnerGithub that keeps one opened source per GitHub source row while that row stays the
 * same, so a GitHub App's installation token is reused across repos and polls instead of minted
 * per call. A changed, disabled or removed source opens again.
 */
export function cachedRunnerGithub(
  repositories: Repositories,
  options: RunnerGithubOptions = {},
): RunnerGithubFor {
  const cache = new Map<number, { key: string; github: RunnerGithub }>()
  return (repoId) => {
    const row = sourceRowOf(repositories, repoId)
    if (!row) return noSource(repositories, repoId)
    const key = `${row.updatedAt.getTime()}`
    const cached = cache.get(row.id)
    if (cached && cached.key === key) return cached.github
    const github = openGithubSource(repositories, row, options)
    if (github.ok) cache.set(row.id, { key, github })
    else cache.delete(row.id)
    return github
  }
}
