import type { DeployRecord } from '@hinomi/shared'
import { z } from 'zod'
import type { CoolifyClient } from './client.js'
import { CoolifyError } from './errors.js'

/**
 * One row of Coolify's deployment queue (`ApplicationDeploymentQueue`). Only the fields
 * Hinomi shows are read; `logs` is never kept.
 */
const queueItemSchema = z.object({
  deployment_uuid: z.string(),
  status: z.string().nullish(),
  commit: z.string().nullish(),
  commit_message: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  is_webhook: z.boolean().nullish(),
  rollback: z.boolean().nullish(),
})
type QueueItem = z.infer<typeof queueItemSchema>

/** Coolify answers either a bare array or `{ count, deployments }`, depending on the version. */
const listSchema = z.union([
  z.array(z.unknown()),
  z.object({ deployments: z.array(z.unknown()) }).transform((body) => body.deployments),
])

const FINISHED = new Set(['finished', 'failed', 'cancelled-by-user', 'cancelled'])

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  // Coolify writes `2026-10-01 12:00:00` (UTC) in some versions.
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toRecord(item: QueueItem): DeployRecord {
  const status = item.status ?? 'unknown'
  // `HEAD` is what Coolify stores for a deploy that was not tied to a commit.
  const commit = item.commit && item.commit !== 'HEAD' ? item.commit : null
  return {
    id: item.deployment_uuid,
    status,
    commit,
    commitMessage: item.commit_message?.trim() || null,
    startedAt: isoOrNull(item.created_at),
    finishedAt: isoOrNull(item.finished_at ?? (FINISHED.has(status) ? item.updated_at : null)),
    webhook: item.is_webhook ?? false,
    rollback: item.rollback ?? false,
  }
}

/**
 * Recent deploys of an application, newest first:
 * `GET /api/v1/deployments/applications/{uuid}?skip=0&take=n`. Rows that do not look like a
 * deploy are skipped rather than failing the list.
 */
export async function fetchApplicationDeploys(
  client: CoolifyClient,
  uuid: string,
  take: number,
): Promise<DeployRecord[]> {
  const path = `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${take}`
  const parsed = listSchema.safeParse(await client.getJson(path))
  if (!parsed.success) {
    throw new CoolifyError('invalid_response', `Coolify returned an unexpected shape for ${path}`)
  }
  const records = parsed.data.flatMap((raw) => {
    const item = queueItemSchema.safeParse(raw)
    return item.success ? [toRecord(item.data)] : []
  })
  return records.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, take)
}
