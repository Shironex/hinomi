import type { DeploymentDeploysResponse } from '@hinomi/shared'
import type { DeploymentRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import {
  CoolifyError,
  createCoolifyClient,
  fetchApplicationDeploys,
} from '../sources/coolify/index.js'

const TIMEOUT_MS = 10_000

const unavailable = (reason: string): DeploymentDeploysResponse => ({
  available: false,
  reason,
  items: [],
})

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
  if (deployment.kind !== 'application') {
    return unavailable('Coolify keeps a deploy history for applications only.')
  }
  const source = repositories.sources.get(deployment.sourceId)
  if (!source || source.kind !== 'coolify')
    return unavailable('The deployment has no Coolify source.')
  if (!source.enabled) return unavailable(`The source "${source.name}" is switched off.`)
  if (!source.baseUrl) return unavailable(`The source "${source.name}" has no URL.`)
  let token: string | null
  try {
    token = repositories.sources.getToken(source.id)
  } catch {
    return unavailable(`The token of "${source.name}" cannot be read. Check HINOMI_SECRET_KEY.`)
  }
  if (!token) return unavailable(`The source "${source.name}" has no token.`)
  try {
    const client = createCoolifyClient({
      baseUrl: source.baseUrl,
      token,
      timeoutMs: TIMEOUT_MS,
      ...(options.fetch && { fetch: options.fetch }),
    })
    const items = await fetchApplicationDeploys(client, deployment.externalId, limit)
    return { available: true, reason: null, items }
  } catch (error) {
    if (error instanceof CoolifyError) return unavailable(error.message)
    throw error
  }
}
