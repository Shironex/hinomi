import type { Repositories } from '../repository/index.js'
import { createGithubSourceFromConfig, type GithubSource } from '../sources/github/index.js'

export interface RunnerGithubOptions {
  fetch?: typeof fetch
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
      ...(options.fetch && { fetch: options.fetch }),
    })
    return { ok: true, source }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
