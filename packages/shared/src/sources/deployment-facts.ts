import { z } from 'zod'
import { mountSourceSchema } from '../guard-evidence.js'
import type { GuardCapability, GuardCheck } from '../guards.js'

// Deployment facts (docs/design/phase-2.md sections 4 and 9.2): what a deployment source
// says about how a container is configured, normalised once per source read and stored on
// the deployment (`deployments.facts`), so guards never call a source. Only parsed values
// are kept: raw run options, compose files, Dockerfiles, environment variables and storage
// contents are never stored, because they can hold secrets.

/** Facts a source can report. A guard whose fact is missing says `unknown`, never pass. */
export const FACT_KEYS = [
  'user',
  'mounts',
  'networks',
  'privileged',
  'image',
  'buildPack',
  'dockerfile',
  'destination',
  'project',
  'autoDeploy',
  'watchPaths',
] as const
export const factKeySchema = z.enum(FACT_KEYS)
export type FactKey = z.infer<typeof factKeySchema>

/** One mount of the container, from run options, compose or the platform's storages. */
export const factMountSchema = z.object({
  /** Where it was read. */
  origin: mountSourceSchema,
  type: z.enum(['bind', 'volume', 'tmpfs', 'other']),
  /** Host path for binds, volume name for volumes, null when anonymous or not reported. */
  source: z.string().nullable(),
  /** Path inside the container. */
  target: z.string().nullable(),
  readOnly: z.boolean(),
  /** Compose service the mount belongs to, null otherwise. */
  service: z.string().nullable(),
})
export type FactMount = z.infer<typeof factMountSchema>

/** A named network outside the platform's own grouping (what links resources across projects). */
export const factNetworkSchema = z.object({
  origin: z.enum(['run_options', 'compose']),
  /** The real network name (compose `name:` or the external name). */
  name: z.string(),
  service: z.string().nullable(),
})
export type FactNetwork = z.infer<typeof factNetworkSchema>

/** One compose service, for compose based deployments. */
export const factServiceSchema = z.object({
  name: z.string(),
  /** `user:` as written (variables resolved from their defaults), null when absent. */
  user: z.string().nullable(),
  /** `image:`, null when the service builds one. */
  image: z.string().nullable(),
  build: z
    .object({
      context: z.string().nullable(),
      dockerfile: z.string().nullable(),
      target: z.string().nullable(),
    })
    .nullable(),
  privileged: z.boolean(),
  /** `network_mode:` (`host`, `service:db`), null when absent. */
  networkMode: z.string().nullable(),
})
export type FactService = z.infer<typeof factServiceSchema>

/** What an inline Dockerfile says about the container user, read once at fetch time. */
export const inlineDockerfileFactSchema = z.object({
  /** `none`: no USER on the final stage chain; `unknown`: it has an unresolved variable. */
  kind: z.enum(['none', 'root', 'non_root', 'unknown']),
  /** The last USER that applies, as written. */
  user: z.string().nullable(),
  /** Line of that USER, or of the final FROM when there is none. */
  line: z.number().int().positive().nullable(),
  /** Alias of the stage that was read (the final one, or the target). */
  stage: z.string().nullable(),
  /** FROM argument of that stage as written. */
  from: z.string().nullable(),
  /** External base image the stage is built on. */
  baseImage: z.string().nullable(),
  /** True when the base image tag ends in `nonroot`. */
  baseNonroot: z.boolean(),
})
export type InlineDockerfileFact = z.infer<typeof inlineDockerfileFactSchema>

export const dockerfileFactSchema = z.object({
  /** Path of the Dockerfile from the base directory, as the source has it. */
  location: z.string().nullable(),
  baseDirectory: z.string().nullable(),
  /** Target build stage, null for the last stage. */
  target: z.string().nullable(),
  /** Read from the source's inline copy; null when the file lives in the repo (read at `commit`). */
  inline: inlineDockerfileFactSchema.nullable(),
})
export type DockerfileFact = z.infer<typeof dockerfileFactSchema>

/** The network grouping of the platform (Coolify: a destination is one Docker network). */
export const destinationFactSchema = z.object({
  /** Server id or uuid as the source gives it, null when it does not say. */
  server: z.string().nullable(),
  /** Destination type, for example `App\Models\StandaloneDocker`. */
  typeName: z.string().nullable(),
  id: z.number().int().nullable(),
})
export type DestinationFact = z.infer<typeof destinationFactSchema>

export const projectFactSchema = z.object({
  /** Stable key for grouping: the project uuid, else its id. */
  key: z.string(),
  name: z.string().nullable(),
  environment: z.string().nullable(),
})
export type ProjectFact = z.infer<typeof projectFactSchema>

export const deploymentFactsSchema = z.object({
  version: z.literal(1),
  /** When the source was read for these facts (ISO). Cached facts keep the time of the read. */
  fetchedAt: z.string(),
  /** Build pack as the source names it (`dockerfile`, `dockercompose`, `nixpacks`, `static`, `dockerimage`). */
  buildPack: z.string().nullable(),
  /** Image the container runs, when the source names one (registry image apps, databases). */
  image: z.string().nullable(),
  /** Deployed commit when the source has a full 40 character sha, else null (read the branch). */
  commit: z.string().nullable(),
  /** `--user` from the run options: wins over compose and the Dockerfile. Null when not set. */
  user: z.string().nullable(),
  /** Compose services, empty for other build packs. */
  services: z.array(factServiceSchema),
  /** Dockerfile build pack only, null otherwise. */
  dockerfile: dockerfileFactSchema.nullable(),
  /** Every mount found, whatever its type; `mountsDockerSocket(facts.mounts)` reads it as is. */
  mounts: z.array(factMountSchema),
  /** Mount sources that were actually read, so a pass can say what it is based on. */
  mountsChecked: z.array(mountSourceSchema),
  /** Named networks from run options and compose external networks. */
  networks: z.array(factNetworkSchema),
  /** `--network host` or compose `network_mode: host`. */
  hostNetwork: z.boolean(),
  /** `--privileged` or compose `privileged: true` on any service. */
  privileged: z.boolean(),
  destination: destinationFactSchema.nullable(),
  /** True when the platform attaches the container to the destination network; null when unknown. */
  attachedToDestination: z.boolean().nullable(),
  project: projectFactSchema.nullable(),
  autoDeploy: z.boolean().nullable(),
  /**
   * Facts the source could not give (or gave only partly) for this deployment, with the
   * reason in words a finding can show, for example `user: "this build pack does not say
   * which user the container runs as"`.
   */
  gaps: z.partialRecord(factKeySchema, z.string().max(300)),
})
export type DeploymentFacts = z.infer<typeof deploymentFactsSchema>

/** Facts a Coolify source can report at all (per deployment, `gaps` narrows it). */
export const COOLIFY_FACTS: ReadonlySet<FactKey> = new Set<FactKey>([
  'user',
  'mounts',
  'networks',
  'privileged',
  'image',
  'buildPack',
  'dockerfile',
  'destination',
  'project',
  'autoDeploy',
  'watchPaths',
])

/**
 * How much of each container check Coolify can answer. No check is `full` except watch
 * paths: Coolify has no field for the container user, lists no networks per resource, and
 * the persistent storage `host_path` is not in its API spec.
 */
export const COOLIFY_GUARD_CAPABILITIES: Partial<Record<GuardCheck, GuardCapability>> = {
  root_user: 'partial',
  docker_socket: 'partial',
  shared_network: 'partial',
  watch_paths_skip: 'full',
}
