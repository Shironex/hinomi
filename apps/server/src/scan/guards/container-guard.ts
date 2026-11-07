import type { GuardResult } from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { GuardContext } from './types.js'

// Shared by the container checks (root_user, docker_socket).

/** Worse results win when one deployment has several signals (several compose services). */
const RESULT_RANK: Record<GuardResult, number> = { pass: 0, unknown: 1, warn: 2, fail: 3 }

export function worst<T extends { result: GuardResult }>(items: readonly T[]): T | undefined {
  let top: T | undefined
  for (const item of items) {
    if (top === undefined || RESULT_RANK[item.result] > RESULT_RANK[top.result]) top = item
  }
  return top
}

/** The repo a deployment runs, from the context's index (manual mappings honoured). */
export function repoOfDeployment(ctx: GuardContext, deployment: DeploymentRow): RepoRow | null {
  for (const repo of ctx.repos) {
    if (ctx.index.byRepo.get(repo.id)?.some((d) => d.id === deployment.id)) return repo
  }
  return null
}
