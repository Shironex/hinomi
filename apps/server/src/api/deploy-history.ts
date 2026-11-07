import type { DeploymentDeploysResponse } from '@hinomi/shared'
import type { DeploymentRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { readAppDeploys } from '../runner/index.js'

/**
 * Recent deploys of one deployment, read live from its Coolify source. Never throws for a
 * source problem: the answer says why the list is empty instead. Messages never hold the token.
 */
export async function readDeployHistory(
  repositories: Repositories,
  deployment: DeploymentRow,
  limit: number,
  options: { fetch?: typeof fetch } = {},
): Promise<DeploymentDeploysResponse> {
  const read = await readAppDeploys(repositories, deployment, limit, options)
  return read.ok
    ? { available: true, reason: null, items: read.items }
    : { available: false, reason: read.reason, items: [] }
}
