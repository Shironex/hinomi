import {
  deploymentsResponseSchema,
  githubWebhookSettingsSchema,
  notifyChannelSchema,
  notifyChannelsResponseSchema,
  notifyChannelTestResultSchema,
  notifySettingsSchema,
  repoOverridesResponseSchema,
  reposResponseSchema,
  rotateGithubWebhookSecretResponseSchema,
  rotateWebhookRunnerSecretResponseSchema,
  scanRunSchema,
  scansResponseSchema,
  settingsSchema,
  webhookRunnerSettingsSchema,
  sourceSchema,
  sourcesResponseSchema,
  sourceTestResultSchema,
  startScanResponseSchema,
  type AddRepoOverrideRequest,
  type CreateNotifyChannelRequest,
  type CreateSourceRequest,
  type TestSourceRequest,
  type UpdateGithubWebhookRequest,
  type UpdateNotifyChannelRequest,
  type UpdateNotifySettingsRequest,
  type UpdateSettingsRequest,
  type UpdateSourceRequest,
  type UpdateWebhookRunnerRequest,
} from '@hinomi/shared'
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { api, request } from './api'

/**
 * Queries and mutations behind onboarding and settings: sources, scan
 * settings, scans, notification channels and repo mapping overrides. Every
 * call parses the answer with the shared contract (packages/shared/src/api.ts).
 */

const noContent = z.undefined()

export const settingsKeys = {
  sources: ['sources'] as const,
  settings: ['settings'] as const,
  scan: (id: number) => ['scans', id] as const,
  latestScan: ['scans', 'latest'] as const,
  channels: ['notifications', 'channels'] as const,
  notifySettings: ['notifications', 'settings'] as const,
  deployments: ['deployments'] as const,
  repos: ['repos'] as const,
  githubWebhook: ['settings', 'github-webhook'] as const,
  webhookRunner: ['settings', 'webhook-runner'] as const,
}

export const sourcesQuery = queryOptions({
  queryKey: settingsKeys.sources,
  queryFn: ({ signal }) => api.get('/sources', sourcesResponseSchema, { signal }),
})

export const settingsQuery = queryOptions({
  queryKey: settingsKeys.settings,
  queryFn: ({ signal }) => api.get('/settings', settingsSchema, { signal }),
})

/** One scan run; polls while it is still running so its source lines fill in. */
export function scanRunQuery(id: number) {
  return queryOptions({
    queryKey: settingsKeys.scan(id),
    queryFn: ({ signal }) => api.get(`/scans/${id}`, scanRunSchema, { signal }),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2_000 : false),
  })
}

/** The newest scan run, to follow a scan that started on its own (first source connected). */
export const latestScanQuery = queryOptions({
  queryKey: settingsKeys.latestScan,
  queryFn: ({ signal }) => api.get('/scans?limit=1', scansResponseSchema, { signal }),
  staleTime: 0,
})

export const channelsQuery = queryOptions({
  queryKey: settingsKeys.channels,
  queryFn: ({ signal }) =>
    api.get('/notifications/channels', notifyChannelsResponseSchema, { signal }),
})

export const notifySettingsQuery = queryOptions({
  queryKey: settingsKeys.notifySettings,
  queryFn: ({ signal }) => api.get('/notifications/settings', notifySettingsSchema, { signal }),
})

export const deploymentsQuery = queryOptions({
  queryKey: settingsKeys.deployments,
  queryFn: ({ signal }) => api.get('/deployments', deploymentsResponseSchema, { signal }),
})

export const reposQuery = queryOptions({
  queryKey: settingsKeys.repos,
  queryFn: ({ signal }) => api.get('/repos', reposResponseSchema, { signal }),
})

export const githubWebhookQuery = queryOptions({
  queryKey: settingsKeys.githubWebhook,
  queryFn: ({ signal }) =>
    api.get('/settings/github-webhook', githubWebhookSettingsSchema, { signal }),
})

export const webhookRunnerQuery = queryOptions({
  queryKey: settingsKeys.webhookRunner,
  queryFn: ({ signal }) =>
    api.get('/settings/webhook-runner', webhookRunnerSettingsSchema, { signal }),
})

// Sources ------------------------------------------------------------------

export const testSourceCredentials = (body: TestSourceRequest) =>
  api.post('/sources/test', sourceTestResultSchema, body)

export const testSavedSource = (id: number) =>
  api.post(`/sources/${id}/test`, sourceTestResultSchema, {})

export const createSource = (body: CreateSourceRequest) => api.post('/sources', sourceSchema, body)

export const updateSource = (id: number, body: UpdateSourceRequest) =>
  request(`/sources/${id}`, sourceSchema, { method: 'PATCH', json: body })

export const removeSource = (id: number) =>
  request(`/sources/${id}`, noContent, { method: 'DELETE' })

// Settings and scans -------------------------------------------------------

export const updateSettings = (body: UpdateSettingsRequest) =>
  request('/settings', settingsSchema, { method: 'PATCH', json: body })

export const startFirstScan = () => api.post('/scans', startScanResponseSchema)

// Notifications ------------------------------------------------------------

export const createChannel = (body: CreateNotifyChannelRequest) =>
  api.post('/notifications/channels', notifyChannelSchema, body)

export const updateChannel = (id: string, body: UpdateNotifyChannelRequest) =>
  request(`/notifications/channels/${id}`, notifyChannelSchema, { method: 'PATCH', json: body })

export const removeChannel = (id: string) =>
  request(`/notifications/channels/${id}`, noContent, { method: 'DELETE' })

export const testChannel = (id: string) =>
  api.post(`/notifications/channels/${id}/test`, notifyChannelTestResultSchema)

export const updateNotifySettings = (body: UpdateNotifySettingsRequest) =>
  request('/notifications/settings', notifySettingsSchema, { method: 'PATCH', json: body })

// Repo mapping -------------------------------------------------------------
// Both answer with the deployment's overrides after the change.

export const addRepoOverride = (deploymentId: number, body: AddRepoOverrideRequest) =>
  api.post(`/deployments/${deploymentId}/overrides`, repoOverridesResponseSchema, body)

export const removeRepoOverride = (deploymentId: number, repoId: number) =>
  request(`/deployments/${deploymentId}/overrides/${repoId}`, repoOverridesResponseSchema, {
    method: 'DELETE',
  })

// GitHub webhook -----------------------------------------------------------

export const updateGithubWebhook = (body: UpdateGithubWebhookRequest) =>
  request('/settings/github-webhook', githubWebhookSettingsSchema, { method: 'PATCH', json: body })

/** Generates or replaces the secret. The answer holds it once, with the settings after. */
export const rotateGithubWebhookSecret = () =>
  api.post('/settings/github-webhook/secret', rotateGithubWebhookSecretResponseSchema)

// Webhook runner -----------------------------------------------------------

/** A URL the server refuses is a 422 whose message says why. */
export const updateWebhookRunner = (body: UpdateWebhookRunnerRequest) =>
  request('/settings/webhook-runner', webhookRunnerSettingsSchema, { method: 'PATCH', json: body })

/** Generates or replaces the secret. The answer holds it once, with the settings after. */
export const rotateWebhookRunnerSecret = () =>
  api.post('/settings/webhook-runner/secret', rotateWebhookRunnerSecretResponseSchema)
