import {
  dispatchFixRunResponseSchema,
  fixPlanSchema,
  fixPlansResponseSchema,
  fixRunDetailSchema,
  fixRunPreviousPrSchema,
  fixRunsResponseSchema,
  isFixRunTerminal,
  runnerStatusSchema,
  type DispatchFixRunResponse,
  type FixRun,
  type FixRunPreviousPr,
  type UpdateRunnerSettingsRequest,
} from '@hinomi/shared'
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api, ApiError, request } from './api'
import { queryKeys as shellKeys } from './queries'

/**
 * Queries and mutations behind fix plans, the GitHub Actions runner and fix runs. Every answer
 * is parsed with its shared schema (packages/shared/src/api.ts, fix-runs.ts, runner-setup.ts).
 */

export const fixKeys = {
  plans: ['plans'] as const,
  plan: (repoId: number) => ['plans', repoId] as const,
  runner: (repoId: number) => ['runner', repoId] as const,
  runs: ['fix-runs'] as const,
  repoRuns: (repoId: number) => ['fix-runs', 'repo', repoId] as const,
  run: (id: number) => ['fix-runs', 'run', id] as const,
}

/** How often a run that has not ended is read again while it is on screen. */
export const LIVE_RUN_POLL_MS = 15_000

export const plansQuery = queryOptions({
  queryKey: fixKeys.plans,
  queryFn: ({ signal }) => api.get('/plans', fixPlansResponseSchema, { signal }),
})

export function planQuery(repoId: number) {
  return queryOptions({
    queryKey: fixKeys.plan(repoId),
    queryFn: ({ signal }) => api.get(`/repos/${repoId}/plan`, fixPlanSchema, { signal }),
  })
}

/** The runner status reads GitHub live, so it is kept for a while instead of read on every focus. */
export function runnerQuery(repoId: number) {
  return queryOptions({
    queryKey: fixKeys.runner(repoId),
    queryFn: ({ signal }) => api.get(`/repos/${repoId}/runner`, runnerStatusSchema, { signal }),
    staleTime: 60_000,
  })
}

const anyLive = (runs: readonly FixRun[] | undefined) =>
  runs?.some((run) => !isFixRunTerminal(run.state)) ?? false

/** The newest runs of one repo; polled while one of them has not ended. */
export function repoRunsQuery(repoId: number, limit = 20) {
  return queryOptions({
    queryKey: fixKeys.repoRuns(repoId),
    queryFn: ({ signal }) =>
      api.get(`/repos/${repoId}/fix-runs?limit=${limit}`, fixRunsResponseSchema, { signal }),
    refetchInterval: (query) => (anyLive(query.state.data?.items) ? LIVE_RUN_POLL_MS : false),
  })
}

/** One run with its tracking, deployments and verification; polled while it has not ended. */
export function fixRunQuery(id: number) {
  return queryOptions({
    queryKey: fixKeys.run(id),
    queryFn: ({ signal }) => api.get(`/fix-runs/${id}`, fixRunDetailSchema, { signal }),
    refetchInterval: (query) =>
      query.state.data && !isFixRunTerminal(query.state.data.state) ? LIVE_RUN_POLL_MS : false,
  })
}

export type DispatchOutcome =
  | { kind: 'created'; response: DispatchFixRunResponse }
  | { kind: 'reopen'; previous: FixRunPreviousPr }

const reopenBodySchema = z.object({ previous: fixRunPreviousPrSchema })

/**
 * Dispatches the repo's latest plan. A 409 carrying `previous` means the last fix PR was closed
 * unmerged and the person has to confirm a fresh one; any other failure throws an ApiError.
 */
export async function dispatchFixRun(
  repoId: number,
  confirmReopen = false,
): Promise<DispatchOutcome> {
  try {
    const response = await api.post(
      `/repos/${repoId}/fix-runs`,
      dispatchFixRunResponseSchema,
      confirmReopen ? { confirmReopen: true } : {},
    )
    return { kind: 'created', response }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const parsed = reopenBodySchema.safeParse(error.body)
      if (parsed.success) return { kind: 'reopen', previous: parsed.data.previous }
    }
    throw error
  }
}

export function updateRunner(repoId: number, body: UpdateRunnerSettingsRequest) {
  return request(`/repos/${repoId}/runner`, runnerStatusSchema, { method: 'PATCH', json: body })
}

/** After a dispatch the repo's runs, its runner status and the run lists are stale. */
export async function refreshAfterDispatch(queryClient: QueryClient, repoId: number) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: fixKeys.repoRuns(repoId) }),
    queryClient.invalidateQueries({ queryKey: fixKeys.runner(repoId) }),
    queryClient.invalidateQueries({ queryKey: ['findings'] }),
    queryClient.invalidateQueries({ queryKey: shellKeys.navCounts }),
  ])
}
