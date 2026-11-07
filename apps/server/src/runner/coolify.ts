import type { DeployRecord } from '@hinomi/shared'
import type { DeploymentRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import {
  CoolifyError,
  createCoolifyClient,
  fetchApplicationDeploys,
} from '../sources/coolify/index.js'

const TIMEOUT_MS = 10_000

/** Recent deploys of one application, or why they could not be read. */
export type AppDeploysRead = { ok: true; items: DeployRecord[] } | { ok: false; reason: string }

/**
 * Recent deploys of one deployment, newest first, read live from its Coolify source. Never
 * throws for a source problem: the answer says why there is no list instead. Messages never
 * hold the token.
 */
export async function readAppDeploys(
  repositories: Repositories,
  deployment: DeploymentRow,
  limit: number,
  options: { fetch?: typeof fetch | undefined } = {},
): Promise<AppDeploysRead> {
  const refuse = (reason: string): AppDeploysRead => ({ ok: false, reason })
  if (deployment.kind !== 'application') {
    return refuse('Coolify keeps a deploy history for applications only.')
  }
  const source = repositories.sources.get(deployment.sourceId)
  if (!source || source.kind !== 'coolify') return refuse('The deployment has no Coolify source.')
  if (!source.enabled) return refuse(`The source "${source.name}" is switched off.`)
  if (!source.baseUrl) return refuse(`The source "${source.name}" has no URL.`)
  let token: string | null
  try {
    token = repositories.sources.getToken(source.id)
  } catch {
    return refuse(`The token of "${source.name}" cannot be read. Check HINOMI_SECRET_KEY.`)
  }
  if (!token) return refuse(`The source "${source.name}" has no token.`)
  try {
    const client = createCoolifyClient({
      baseUrl: source.baseUrl,
      token,
      timeoutMs: TIMEOUT_MS,
      ...(options.fetch && { fetch: options.fetch }),
    })
    return { ok: true, items: await fetchApplicationDeploys(client, deployment.externalId, limit) }
  } catch (error) {
    if (error instanceof CoolifyError) return refuse(error.message)
    throw error
  }
}
