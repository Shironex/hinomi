import {
  deploymentItemSchema,
  importManualDeploymentsResponseSchema,
  type CreateManualDeploymentRequest,
  type ImportManualDeploymentsRequest,
  type UpdateManualDeploymentRequest,
} from '@hinomi/shared'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api, request } from './api'
import { queryKeys } from './queries'
import { settingsKeys } from './settings-api'

/** The entries of a manual list (docs/api.md, Deployments). The list itself is `GET /deployments`. */

export const createManualDeployment = (body: CreateManualDeploymentRequest) =>
  api.post('/deployments', deploymentItemSchema, body)

export const updateManualDeployment = (id: number, body: UpdateManualDeploymentRequest) =>
  request(`/deployments/${id}`, deploymentItemSchema, { method: 'PATCH', json: body })

export const removeManualDeployment = (id: number) =>
  request(`/deployments/${id}`, z.undefined(), { method: 'DELETE' })

export const importManualDeployments = (body: ImportManualDeploymentsRequest) =>
  api.post('/deployments/import', importManualDeploymentsResponseSchema, body)

/** After a write: the entries, the source's count and what the nav counts of deployments show. */
export function refreshManualList(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: settingsKeys.deployments }),
    queryClient.invalidateQueries({ queryKey: settingsKeys.sources }),
    queryClient.invalidateQueries({ queryKey: queryKeys.navCounts }),
  ])
}
