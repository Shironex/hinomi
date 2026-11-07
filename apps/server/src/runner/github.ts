import type { Repositories } from '../repository/index.js'
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

/** The GitHub source the runner talks through, or why there is none. */
export type RunnerGithub = { ok: true; source: GithubSource } | { ok: false; message: string }

/**
 * The connected GitHub source, the same one scans use (the first enabled source with a stored
 * token or private key), bound to its decrypted secret.
 */
export function openRunnerGithub(
  repositories: Repositories,
  options: RunnerGithubOptions = {},
): RunnerGithub {
  const row = repositories.sources
    .listByKind('github')
    .find((source) => source.enabled && source.hasToken)
  if (!row) return { ok: false, message: 'Connect a GitHub source first.' }
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
 * openRunnerGithub that keeps the source between calls while the stored source row stays the
 * same, so a GitHub App's installation token is reused instead of minted per poll. A changed,
 * disabled or removed source opens again.
 */
export function cachedRunnerGithub(
  repositories: Repositories,
  options: RunnerGithubOptions = {},
): () => RunnerGithub {
  let cached: { key: string; github: RunnerGithub } | null = null
  return () => {
    const row = repositories.sources
      .listByKind('github')
      .find((source) => source.enabled && source.hasToken)
    const key = row ? `${row.id}:${row.updatedAt.getTime()}` : ''
    if (cached && cached.key === key) return cached.github
    const github = openRunnerGithub(repositories, options)
    cached = github.ok ? { key, github } : null
    return github
  }
}
