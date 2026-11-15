import { COOLIFY_CAPABILITIES } from '@hinomi/shared'
import type {
  CachedFacts,
  DeploymentSource,
  DeploymentSourceConfig,
  DeploymentSourceFactory,
  DeployHistoryRead,
} from '../deployments/types.js'
import { createCoolifyClient, type CoolifyClient } from './client.js'
import { fetchApplicationDeploys } from './deploys.js'
import { CoolifyError } from './errors.js'
import { fetchCoolifyInventory } from './inventory.js'
import { fetchResourceScan, probeImageScan } from './vulnerabilities.js'

// Coolify behind the deployment source interface: the inventory with its facts, the deploy
// history of applications and Coolify's own image scan results.

/** A missing URL or token, said the same way wherever the source is used. */
function configError(config: DeploymentSourceConfig): string | null {
  if (!config.baseUrl) return `The source "${config.name}" has no URL.`
  return null
}

function openCoolify(config: DeploymentSourceConfig): DeploymentSource {
  let client: CoolifyClient | null = null
  const connect = (): CoolifyClient => {
    const problem = configError(config)
    if (problem) throw new Error(problem)
    client ??= createCoolifyClient({
      baseUrl: config.baseUrl!,
      token: config.token(),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      ...(config.fetch && { fetch: config.fetch }),
    })
    return client
  }

  return {
    sourceId: config.sourceId,
    kind: 'coolify',
    name: config.name,
    capabilities: COOLIFY_CAPABILITIES,

    inventory: async () => {
      const problem = configError(config)
      if (problem) throw new Error(problem)
      // Facts are read again only for resources that changed since the last scan.
      const cached = config.cachedFacts?.() ?? new Map<string, CachedFacts>()
      return fetchCoolifyInventory({
        name: config.name,
        baseUrl: config.baseUrl!,
        token: config.token(),
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
        ...(config.fetch && { fetch: config.fetch }),
        facts: { cached: (externalId) => cached.get(externalId) },
      })
    },

    deployHistory: async (deployment, limit): Promise<DeployHistoryRead> => {
      if (deployment.kind !== 'application') {
        return { ok: false, reason: 'Coolify keeps a deploy history for applications only.' }
      }
      let bound: CoolifyClient
      try {
        bound = connect()
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      try {
        return {
          ok: true,
          items: await fetchApplicationDeploys(bound, deployment.externalId, limit),
        }
      } catch (error) {
        if (error instanceof CoolifyError) return { ok: false, reason: error.message }
        throw error
      }
    },

    imageScan: {
      probe: async () => probeImageScan(connect()),
      resource: async (kind, externalId) => fetchResourceScan(connect(), kind, externalId),
    },
  }
}

export const coolifyDeploymentSource: DeploymentSourceFactory = {
  kind: 'coolify',
  capabilities: COOLIFY_CAPABILITIES,
  open: openCoolify,
}
