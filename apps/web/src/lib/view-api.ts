import {
  bulkFindingsResponseSchema,
  deploymentDeploysResponseSchema,
  deploymentDetailSchema,
  findingDetailSchema,
  findingsResponseSchema,
  fixesResponseSchema,
  overviewResponseSchema,
  type BulkFindingsRequest,
  type DeferFindingRequest,
  type FindingDetail,
  type FindingGroup,
  type FindingTier,
  type ReopenFindingRequest,
} from '@hinomi/shared'
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type QueryClient,
} from '@tanstack/react-query'
import { api } from './api'
import { queryKeys as shellKeys } from './queries'
import { settingsKeys } from './settings-api'

// The deployment and repo lists are shared with Settings, so both views read one cache entry.
export { deploymentsQuery, reposQuery } from './settings-api'

/**
 * Queries and mutations behind the overview, alerts, finding and deployment views. Every
 * response is parsed with its shared schema, so the views only ever see the API contract.
 */

export const viewKeys = {
  overview: ['overview'] as const,
  findings: ['findings'] as const,
  findingsList: (params: FindingsParams) => ['findings', params] as const,
  finding: (id: number) => ['finding', id] as const,
  deployments: settingsKeys.deployments,
  deployment: (id: number) => ['deployment', id] as const,
  deploys: (id: number) => ['deployment', id, 'deploys'] as const,
  fixes: ['fixes'] as const,
}

export const overviewQuery = queryOptions({
  queryKey: viewKeys.overview,
  queryFn: ({ signal }) => api.get('/overview', overviewResponseSchema, { signal }),
})

/** Filters of GET /api/findings as the views hold them: lists, not comma strings. */
export interface FindingsParams {
  tier?: readonly FindingTier[]
  state?: readonly string[]
  severity?: readonly string[]
  source?: readonly string[]
  /** `all`: reported by every listed source. */
  sourceMatch?: 'any' | 'all'
  scope?: readonly string[]
  kind?: readonly string[]
  /** Guard checks and levels; only guard findings match them. */
  check?: readonly string[]
  level?: readonly string[]
  /** true: only desktop release findings; false: none of them. */
  release?: boolean
  repo?: readonly number[]
  deployment?: readonly number[]
  q?: string
  group?: FindingGroup
  limit?: number
}

/** Builds the query string; empty filters are left out so the server applies its defaults. */
export function findingsSearch(params: FindingsParams, offset = 0): string {
  const search = new URLSearchParams()
  for (const key of [
    'tier',
    'state',
    'severity',
    'source',
    'scope',
    'kind',
    'check',
    'level',
  ] as const) {
    const values = params[key]
    if (values?.length) search.set(key, values.join(','))
  }
  if (params.sourceMatch === 'all' && params.source?.length) search.set('sourceMatch', 'all')
  if (params.release !== undefined) search.set('release', String(params.release))
  if (params.repo?.length) search.set('repo', params.repo.join(','))
  if (params.deployment?.length) search.set('deployment', params.deployment.join(','))
  const q = params.q?.trim()
  if (q) search.set('q', q)
  if (params.group && params.group !== 'none') search.set('group', params.group)
  if (offset > 0) search.set('offset', String(offset))
  if (params.limit) search.set('limit', String(params.limit))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function fetchFindings(params: FindingsParams, offset = 0, signal?: AbortSignal) {
  return api.get(`/findings${findingsSearch(params, offset)}`, findingsResponseSchema, { signal })
}

/** One page of findings. Keeps the previous rows on screen while new filters load. */
export function findingsQuery(params: FindingsParams) {
  return queryOptions({
    queryKey: viewKeys.findingsList(params),
    queryFn: ({ signal }) => fetchFindings(params, 0, signal),
    placeholderData: keepPreviousData,
  })
}

/** Every page loaded so far, for the alerts table's "show more". */
export function findingsInfiniteQuery(params: FindingsParams) {
  return infiniteQueryOptions({
    queryKey: [...viewKeys.findingsList(params), 'pages'] as const,
    queryFn: ({ signal, pageParam }) => fetchFindings(params, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    placeholderData: keepPreviousData,
  })
}

/** Open findings grouped by the bump that clears them, every page loaded so far. */
export function fixesInfiniteQuery(limit = 25) {
  return infiniteQueryOptions({
    queryKey: [...viewKeys.fixes, { limit }, 'pages'] as const,
    queryFn: ({ signal, pageParam }) =>
      api.get(
        `/fixes?limit=${limit}${pageParam > 0 ? `&offset=${pageParam}` : ''}`,
        fixesResponseSchema,
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })
}

export function findingQuery(id: number) {
  return queryOptions({
    queryKey: viewKeys.finding(id),
    queryFn: ({ signal }) => api.get(`/findings/${id}`, findingDetailSchema, { signal }),
  })
}

export function deploymentQuery(id: number) {
  return queryOptions({
    queryKey: viewKeys.deployment(id),
    queryFn: ({ signal }) => api.get(`/deployments/${id}`, deploymentDetailSchema, { signal }),
  })
}

/** Recent deploys, read live from Coolify by the server. Not retried: the answer says why. */
export function deploysQuery(id: number) {
  return queryOptions({
    queryKey: viewKeys.deploys(id),
    queryFn: ({ signal }) =>
      api.get(`/deployments/${id}/deploys?limit=8`, deploymentDeploysResponseSchema, { signal }),
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Decisions on a finding

export type DeferKind = 'snooze' | 'accept'

export function deferFinding(id: number, kind: DeferKind, body: DeferFindingRequest) {
  return api.post(`/findings/${id}/${kind}`, findingDetailSchema, body)
}

/** One decision for many findings; the answer lists each finding's outcome. */
export function bulkFindings(body: BulkFindingsRequest) {
  return api.post('/findings/bulk', bulkFindingsResponseSchema, body)
}

export function reopenFinding(id: number, body: ReopenFindingRequest = {}) {
  return api.post(`/findings/${id}/reopen`, findingDetailSchema, body)
}

/** After a decision every count and list that shows the finding is stale. */
export async function refreshAfterDecision(queryClient: QueryClient, detail?: FindingDetail) {
  if (detail) queryClient.setQueryData(viewKeys.finding(detail.id), detail)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: viewKeys.findings }),
    queryClient.invalidateQueries({ queryKey: viewKeys.overview }),
    queryClient.invalidateQueries({ queryKey: viewKeys.fixes }),
    queryClient.invalidateQueries({ queryKey: viewKeys.deployments }),
    queryClient.invalidateQueries({ queryKey: ['deployment'] }),
    queryClient.invalidateQueries({ queryKey: shellKeys.navCounts }),
  ])
}
