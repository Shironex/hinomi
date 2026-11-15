import type { GuardCapability, GuardCheck } from '../guards.js'
import type { DeploymentFacts, FactKey } from './deployment-facts.js'

// The manual deployment list (docs/design/phase-2.md section 9.5, docs/sources.md): deployments
// typed in by hand, through the web form, the API or a YAML file. A manual entry says what runs
// where and nothing about how the container is configured, so every container check is `unknown`.

/** What a manual list declares it can tell: no container facts at all. */
export const MANUAL_FACTS: ReadonlySet<FactKey> = new Set<FactKey>()

/** Every container check says `unknown` for a manual entry (`framework_support` and `runtime_support` read the repo). */
export const MANUAL_GUARD_CAPABILITIES: Partial<Record<GuardCheck, GuardCapability>> = {
  root_user: 'unknown',
  docker_socket: 'unknown',
  shared_network: 'unknown',
  watch_paths_skip: 'unknown',
}

const NO_DETAILS = 'a manual entry lists no container details'

/**
 * The facts stored for a manual entry: every container fact is a gap with the reason, so a guard
 * says `unknown` and shows why, instead of "not reported yet".
 */
export function manualFacts(image: string | null, fetchedAt: string): DeploymentFacts {
  return {
    version: 1,
    fetchedAt,
    buildPack: null,
    image,
    commit: null,
    user: null,
    services: [],
    dockerfile: null,
    mounts: [],
    mountsChecked: [],
    networks: [],
    hostNetwork: false,
    privileged: false,
    destination: null,
    attachedToDestination: null,
    project: null,
    autoDeploy: null,
    gaps: {
      user: NO_DETAILS,
      mounts: NO_DETAILS,
      networks: NO_DETAILS,
      destination: NO_DETAILS,
      project: NO_DETAILS,
      autoDeploy: NO_DETAILS,
      watchPaths: NO_DETAILS,
    },
  }
}
