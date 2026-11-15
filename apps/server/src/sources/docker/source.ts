import {
  DOCKER_CAPABILITIES,
  readDockerSourceConfig,
  type DockerSourceConfig,
} from '@hinomi/shared'
import type {
  DeploymentSource,
  DeploymentSourceConfig,
  DeploymentSourceFactory,
} from '../deployments/types.js'
import { DockerError } from './errors.js'
import { fetchDockerInventory } from './inventory.js'
import { ownContainerIds } from './self.js'
import { createDockerTransport, type DockerEndpoint } from './transport.js'

// A Docker host behind the deployment source interface: the inventory with facts from container
// inspect. No deploy history and no image scan of its own (the registry SBOM half covers its
// images). Read only by construction: the transport sends nothing but GET.

/**
 * Where to connect, from the stored config, the endpoint URL and the client key. Throws a
 * `DockerError` that names what is missing; the key is read only when a client certificate is set.
 */
export function dockerEndpointOf(
  config: DockerSourceConfig | null,
  baseUrl: string | null,
  key: () => string | null,
): DockerEndpoint {
  if (!config) throw new DockerError('config', 'The Docker source has no connection settings')
  if (config.transport === 'socket') {
    if (!config.socketPath) throw new DockerError('config', 'The Docker source has no socket path')
    return { transport: 'socket', socketPath: config.socketPath }
  }
  if (!baseUrl) throw new DockerError('config', 'The Docker source has no endpoint URL')
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new DockerError(
      'insecure',
      'Plain TCP without TLS is refused: Docker API access is root on the host. Use an https endpoint, or a socket.',
    )
  }
  const clientKey = config.cert ? key() : null
  if (config.cert && !clientKey) {
    throw new DockerError('config', 'The client certificate is set but its key is not stored')
  }
  return { transport: 'tls', url: baseUrl, ca: config.ca, cert: config.cert, key: clientKey }
}

function openDocker(config: DeploymentSourceConfig): DeploymentSource {
  return {
    sourceId: config.sourceId,
    kind: 'docker',
    name: config.name,
    capabilities: DOCKER_CAPABILITIES,

    inventory: async () => {
      const settings = readDockerSourceConfig(config.config ?? null)
      const endpoint = dockerEndpointOf(settings, config.baseUrl, config.token)
      const transport = createDockerTransport(endpoint, {
        ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      })
      return fetchDockerInventory({
        transport,
        name: config.name,
        optIn: settings?.optIn ?? true,
        ownIds: ownContainerIds(),
      })
    },
  }
}

export const dockerDeploymentSource: DeploymentSourceFactory = {
  kind: 'docker',
  capabilities: DOCKER_CAPABILITIES,
  // A socket needs no secret; a TLS client key is read only when a client certificate is set.
  needsToken: false,
  open: openDocker,
}
