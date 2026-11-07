import {
  checkOverrideSchema,
  checkOverridesResponseSchema,
  guardsResponseSchema,
  type CreateCheckOverrideRequest,
} from '@hinomi/shared'
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api, request } from './api'
import { refreshAfterDecision } from './view-api'

/**
 * The check registry and check overrides (docs/api.md, "Guards and check overrides"). Turning a
 * check off accepts its findings right away, so every write refreshes what the decisions do.
 */

export const guardKeys = {
  guards: ['guards'] as const,
  overrides: ['overrides'] as const,
}

export const guardsQuery = queryOptions({
  queryKey: guardKeys.guards,
  queryFn: ({ signal }) => api.get('/guards', guardsResponseSchema, { signal }),
})

export const overridesQuery = queryOptions({
  queryKey: guardKeys.overrides,
  queryFn: ({ signal }) => api.get('/overrides', checkOverridesResponseSchema, { signal }),
})

export function createOverride(body: CreateCheckOverrideRequest) {
  return api.post('/overrides', checkOverrideSchema, body)
}

export function updateOverride(id: number, reason: string) {
  return request(`/overrides/${id}`, checkOverrideSchema, {
    method: 'PATCH',
    json: { reason },
  })
}

export function deleteOverride(id: number) {
  return request(`/overrides/${id}`, z.undefined(), { method: 'DELETE' })
}

/** After an override changes, findings, counts and both registries are stale. */
export async function refreshAfterOverride(queryClient: QueryClient) {
  await Promise.all([
    refreshAfterDecision(queryClient),
    queryClient.invalidateQueries({ queryKey: ['finding'] }),
    queryClient.invalidateQueries({ queryKey: guardKeys.guards }),
    queryClient.invalidateQueries({ queryKey: guardKeys.overrides }),
  ])
}
