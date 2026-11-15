import {
  registryCredentialSchema,
  registryCredentialsResponseSchema,
  type CreateRegistryCredentialRequest,
  type UpdateRegistryCredentialRequest,
} from '@hinomi/shared'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { api, request } from './api'

/**
 * Registry credentials for private images in the SBOM image scan. The secret is write only: the
 * answers carry the host, the user name and whether a secret is stored.
 */

const BASE = '/settings/registry-credentials'

export const registryCredentialsKey = ['settings', 'registry-credentials'] as const

export const registryCredentialsQuery = queryOptions({
  queryKey: registryCredentialsKey,
  queryFn: ({ signal }) => api.get(BASE, registryCredentialsResponseSchema, { signal }),
})

export const createRegistryCredential = (body: CreateRegistryCredentialRequest) =>
  api.post(BASE, registryCredentialSchema, body)

export const updateRegistryCredential = (id: number, body: UpdateRegistryCredentialRequest) =>
  request(`${BASE}/${id}`, registryCredentialSchema, { method: 'PATCH', json: body })

export const removeRegistryCredential = (id: number) =>
  request(`${BASE}/${id}`, z.undefined(), { method: 'DELETE' })
