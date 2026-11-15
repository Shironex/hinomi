import type { DeploymentRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { openDeploymentSource, type DeployHistoryRead } from '../sources/deployments/index.js'

const TIMEOUT_MS = 10_000

/** Recent deploys of one deployment, or why they could not be read. */
export type AppDeploysRead = DeployHistoryRead

/**
 * Recent deploys of one deployment, newest first, read live from its deployment source. Never
 * throws for a source problem: the answer says why there is no list instead. Messages never hold
 * the token.
 */
export async function readAppDeploys(
  repositories: Repositories,
  deployment: DeploymentRow,
  limit: number,
  options: { fetch?: typeof fetch | undefined } = {},
): Promise<AppDeploysRead> {
  const refuse = (reason: string): AppDeploysRead => ({ ok: false, reason })
  const row = repositories.sources.get(deployment.sourceId)
  if (!row) return refuse('The deployment has no source.')
  const source = openDeploymentSource(
    row,
    { getToken: (id) => repositories.sources.getToken(id) },
    { timeoutMs: TIMEOUT_MS, ...(options.fetch && { fetch: options.fetch }) },
  )
  if (!source) return refuse('The deployment has no deployment source.')
  if (!source.deployHistory) return refuse(`The source "${row.name}" keeps no deploy history.`)
  if (!row.enabled) return refuse(`The source "${row.name}" is switched off.`)
  return source.deployHistory(deployment, limit)
}
