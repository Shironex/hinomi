import { z } from 'zod'
import type { GithubClient } from './client.js'
import { parsePayload } from './schemas.js'
import { conditionalGet, type ConditionalRead } from './runs.js'

// The checks on a commit, as one status: GitHub keeps them in two places, check runs (GitHub
// Actions and apps) and commit statuses (older integrations). Both are read with ETags.

/**
 * The combined state of the checks on a commit. `none` when nothing reported at all (the repo
 * runs no checks on the PR, or they have not started yet).
 */
export type GithubChecksStatus = 'passing' | 'failing' | 'pending' | 'none'

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** Conclusions of a finished check run that count as a pass. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])
/** Conclusions that count as a failure. `stale` and an unknown value count as not finished. */
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
  'cancelled',
])

export interface CheckRunLike {
  status: string
  conclusion: string | null
}

/** The status of a list of check runs: failing wins, then pending, then passing. */
export function summarizeCheckRuns(runs: readonly CheckRunLike[]): GithubChecksStatus {
  if (runs.length === 0) return 'none'
  let pending = false
  for (const run of runs) {
    const conclusion = run.conclusion ?? ''
    if (run.status === 'completed' && FAILING_CONCLUSIONS.has(conclusion)) return 'failing'
    if (run.status !== 'completed' || !PASSING_CONCLUSIONS.has(conclusion)) pending = true
  }
  return pending ? 'pending' : 'passing'
}

/** The combined commit status (`state` over `total_count` statuses) as a checks status. */
export function summarizeCombinedStatus(state: string, totalCount: number): GithubChecksStatus {
  if (totalCount === 0) return 'none'
  if (state === 'failure' || state === 'error') return 'failing'
  if (state === 'success') return 'passing'
  return 'pending'
}

/** Both sources as one status: failing wins, then pending, then passing, else none. */
export function combineChecks(...statuses: GithubChecksStatus[]): GithubChecksStatus {
  for (const wanted of ['failing', 'pending', 'passing'] as const) {
    if (statuses.includes(wanted)) return wanted
  }
  return 'none'
}

const checkRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
})

/**
 * GET /repos/{owner}/{repo}/commits/{sha}/check-runs (the first 100) with the last ETag, as a
 * status. More than 100 check runs on one commit is rare; the first page decides then.
 */
export function fetchCheckRunsStatus(
  client: GithubClient,
  input: { owner: string; name: string; sha: string },
  etag?: string | null,
): Promise<ConditionalRead<GithubChecksStatus>> {
  const path = `${repoPath(input.owner, input.name)}/commits/${encodeURIComponent(input.sha)}/check-runs?per_page=100`
  return conditionalGet(client, path, etag, (result) =>
    summarizeCheckRuns(parsePayload(checkRunsSchema, result.data, 'check runs').check_runs),
  )
}

const combinedStatusSchema = z.object({
  state: z.string(),
  total_count: z.number().int().nonnegative(),
})

/** GET /repos/{owner}/{repo}/commits/{sha}/status with the last ETag, as a status. */
export function fetchCombinedStatus(
  client: GithubClient,
  input: { owner: string; name: string; sha: string },
  etag?: string | null,
): Promise<ConditionalRead<GithubChecksStatus>> {
  const path = `${repoPath(input.owner, input.name)}/commits/${encodeURIComponent(input.sha)}/status`
  return conditionalGet(client, path, etag, (result) => {
    const status = parsePayload(combinedStatusSchema, result.data, 'commit status')
    return summarizeCombinedStatus(status.state, status.total_count)
  })
}
