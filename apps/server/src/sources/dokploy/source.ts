import { DOKPLOY_CAPABILITIES } from '@hinomi/shared'
import type {
  DeploymentSource,
  DeploymentSourceConfig,
  DeploymentSourceFactory,
} from '../deployments/types.js'
import { fetchDokployInventory } from './inventory.js'

// Dokploy behind the deployment source interface: the inventory only. It keeps no deploy
// history here and has no image scan of its own, so both are absent.

function openDokploy(config: DeploymentSourceConfig): DeploymentSource {
  return {
    sourceId: config.sourceId,
    kind: 'dokploy',
    name: config.name,
    capabilities: DOKPLOY_CAPABILITIES,
    inventory: async () => {
      if (!config.baseUrl) throw new Error(`The source "${config.name}" has no URL.`)
      return fetchDokployInventory({
        name: config.name,
        baseUrl: config.baseUrl,
        token: config.token(),
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
        ...(config.fetch && { fetch: config.fetch }),
      })
    },
  }
}

export const dokployDeploymentSource: DeploymentSourceFactory = {
  kind: 'dokploy',
  capabilities: DOKPLOY_CAPABILITIES,
  needsToken: true,
  open: openDokploy,
}
