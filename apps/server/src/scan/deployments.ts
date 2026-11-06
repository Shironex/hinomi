import type { DeploymentRecord } from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../db/schema.js'
import { deploymentInputFromRecord, type Repositories } from '../repository/index.js'
import { reachOf, type ExposureReach } from './rank.js'

/** Splits a normalised `owner/name` into its parts, or null when it is not one. */
export function splitRepo(full: string | null): { owner: string; name: string } | null {
  if (!full) return null
  const parts = full.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], name: parts[1] }
}

/**
 * Stores the deployments one source reported: maps each git repository to a
 * repo row (creating it), upserts the deployment and removes the ones the
 * source no longer reports. Manual overrides are kept: they live in their
 * own table and replace the automatic repo when read.
 */
export function syncDeployments(
  repositories: Repositories,
  sourceId: number,
  records: readonly DeploymentRecord[],
  now: Date,
): { deployments: number; removed: number } {
  return repositories.db.transaction(() => {
    for (const record of records) {
      const parts = splitRepo(record.repo)
      const repoId = parts ? repositories.repos.upsert(parts).id : null
      repositories.deployments.upsert(deploymentInputFromRecord(record, sourceId, repoId), now)
    }
    const removed = repositories.deployments.removeMissing(
      sourceId,
      records.map((r) => r.externalId),
    )
    return { deployments: records.length, removed }
  })
}

/** Deployments grouped by the repos they run (overrides honoured). */
export interface DeploymentIndex {
  deployments: DeploymentRow[]
  byRepo: Map<number, DeploymentRow[]>
  /** Deployments that run no repo at all. */
  unmapped: DeploymentRow[]
}

export function indexDeployments(repositories: Repositories): DeploymentIndex {
  const deployments = repositories.deployments.list()
  const byRepo = new Map<number, DeploymentRow[]>()
  const unmapped: DeploymentRow[] = []
  for (const deployment of deployments) {
    const repoIds = repositories.deployments.effectiveRepoIds(deployment.id)
    if (repoIds.length === 0) unmapped.push(deployment)
    for (const repoId of repoIds) {
      const list = byRepo.get(repoId) ?? []
      list.push(deployment)
      byRepo.set(repoId, list)
    }
  }
  return { deployments, byRepo, unmapped }
}

export function repoReach(index: DeploymentIndex, repoId: number): ExposureReach {
  return reachOf(index.byRepo.get(repoId) ?? [])
}

/**
 * Branch to read lockfiles from: the branch a deployment runs when there is
 * one (that is what is live), otherwise the default branch.
 */
export function lockfileRef(
  repo: Pick<RepoRow, 'defaultBranch'>,
  deployments: readonly DeploymentRow[],
  defaultBranch: string | null,
): string | null {
  const deployed = deployments.find((d) => d.gitBranch)?.gitBranch
  return deployed ?? (defaultBranch || null) ?? repo.defaultBranch ?? null
}

/**
 * A service or app with no git source at all: a template service, or an app
 * deployed from a registry image. There is no repo to map; it gets a coverage
 * note (the phase 2 image scan covers it), never a blind spot. Databases are
 * neither.
 */
export function isImageOnly(deployment: Pick<DeploymentRow, 'kind' | 'gitRepository'>): boolean {
  return deployment.kind !== 'database' && deployment.gitRepository === null
}

/**
 * A deployment built from git needs a repo. When Hinomi cannot match one it
 * is a blind spot (nothing checks what it runs). Databases and image only
 * deployments need none.
 */
export function needsRepoMapping(
  deployment: Pick<DeploymentRow, 'kind' | 'gitRepository'>,
): boolean {
  return deployment.kind !== 'database' && !isImageOnly(deployment)
}
