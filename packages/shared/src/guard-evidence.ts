import { z } from 'zod'
import {
  guardResultSchema,
  runtimePinSourceSchema,
  runtimeSchema,
  supportBasisSchema,
} from './guards.js'

// Evidence of a guard finding, one shape per check (docs/design/phase-2.md
// section 4 and 5). Stored as JSON on the finding and sent with it, so the UI
// can say where the signal came from ("from Dockerfile line 31"). Every shape
// has `reason`: why the level is `unknown`, or a note on a partial signal.

const line = z.number().int().positive().nullable()
const reason = z.string().max(500).nullable().default(null)
/** A day as endoflife.date writes it, `YYYY-MM-DD`. */
const day = z.iso.date()

// ---------------------------------------------------------------------------
// Container configuration checks

/** Where a container fact was read. `none`: the source gives no signal for it. */
export const CONTAINER_SIGNAL_SOURCES = [
  'docker_inspect',
  'run_options',
  'compose',
  'dockerfile',
  'none',
] as const
export const containerSignalSourceSchema = z.enum(CONTAINER_SIGNAL_SOURCES)
export type ContainerSignalSource = z.infer<typeof containerSignalSourceSchema>

/** One compose service's user, for compose deployments. */
export const rootUserServiceSchema = z.object({
  name: z.string(),
  /** `user:` of the service, null when it sets none. */
  user: z.string().nullable(),
  /** `image:` of the service, null when it builds one. */
  image: z.string().nullable(),
  result: guardResultSchema,
})
export type RootUserService = z.infer<typeof rootUserServiceSchema>

export const rootUserEvidenceSchema = z.object({
  check: z.literal('root_user'),
  /** The signal that decided the level (the first in precedence order that answered). */
  source: containerSignalSourceSchema,
  /** The user as read, null when none is set. `""` from Docker inspect means root. */
  user: z.string().nullable(),
  /** Dockerfile path in the repo, null for other sources or an inline Dockerfile. */
  path: z.string().nullable(),
  /** Line of the `USER` (or of the final `FROM` when there is no USER). */
  line,
  /** Base image of the final stage, for example `node:22-alpine`. */
  from: z.string().nullable(),
  /** Name of the final stage (`FROM x AS name`), or the target stage when one is set. */
  stage: z.string().nullable(),
  /** Commit the Dockerfile was read at, null when it was inline or not read. */
  commit: z.string().nullable(),
  /** Compose deployments: one entry per service. Empty otherwise. */
  services: z.array(rootUserServiceSchema),
  reason,
})
export type RootUserEvidence = z.infer<typeof rootUserEvidenceSchema>

/** Where a mount was found. */
export const MOUNT_SOURCES = [
  'docker_inspect',
  'run_options',
  'compose',
  'file_storage',
  'persistent_storage',
] as const
export const mountSourceSchema = z.enum(MOUNT_SOURCES)
export type MountSource = z.infer<typeof mountSourceSchema>

export const socketMountSchema = z.object({
  source: mountSourceSchema,
  /** Host path, for example `/var/run/docker.sock` or `/var/run`. */
  hostPath: z.string(),
  containerPath: z.string().nullable(),
  /** Read only does not help: every API call still works. Shown, never a pass. */
  readOnly: z.boolean(),
  /** Compose service the mount belongs to, null otherwise. */
  service: z.string().nullable(),
})
export type SocketMount = z.infer<typeof socketMountSchema>

export const dockerSocketEvidenceSchema = z.object({
  check: z.literal('docker_socket'),
  /** Mounts of the socket or a folder holding it. Empty on pass and unknown. */
  mounts: z.array(socketMountSchema),
  /** Which sources were read, so a pass says what it is based on. */
  checked: z.array(mountSourceSchema),
  reason,
})
export type DockerSocketEvidence = z.infer<typeof dockerSocketEvidenceSchema>

/**
 * How two resources were found to share a network. `coolify_destination`: same server and
 * destination, both attached to its network. `external_network`: both name the same external
 * network. `docker_network`: Docker inspect lists the same network. `host_network`: the
 * container uses the host network.
 */
export const NETWORK_BASES = [
  'coolify_destination',
  'external_network',
  'docker_network',
  'host_network',
] as const
export const networkBasisSchema = z.enum(NETWORK_BASES)
export type NetworkBasis = z.infer<typeof networkBasisSchema>

export const networkPeerSchema = z.object({
  /** Null when the peer is not in Hinomi's inventory (a container the source sees but does not list). */
  deploymentId: z.number().int().positive().nullable(),
  name: z.string(),
  project: z.string().nullable(),
  /** A database: makes the finding `fail`. */
  database: z.boolean(),
})
export type NetworkPeer = z.infer<typeof networkPeerSchema>

export const sharedNetworkEvidenceSchema = z.object({
  check: z.literal('shared_network'),
  basis: networkBasisSchema.nullable(),
  /** Network name when known. Coolify destinations are grouped by id, so it can be null. */
  network: z.string().nullable(),
  destination: z
    .object({
      server: z.string().nullable(),
      type: z.string().nullable(),
      id: z.number().int(),
    })
    .nullable(),
  /** The deployment's own project key. */
  project: z.string().nullable(),
  /** Resources of other projects on the same network. */
  peers: z.array(networkPeerSchema),
  reason,
})
export type SharedNetworkEvidence = z.infer<typeof sharedNetworkEvidenceSchema>

export const watchPathsSkipEvidenceSchema = z.object({
  check: z.literal('watch_paths_skip'),
  /** Watch path patterns in order, as the source stores them. */
  patterns: z.array(z.string()),
  /** Auto deploy on the source; null when it does not say. Off means pass. */
  autoDeploy: z.boolean().nullable(),
  /** Files checked against the patterns: Dockerfile, lockfiles, manifests, runtime pins. */
  checked: z.array(z.string()),
  /** Checked files that do not trigger a deploy. */
  skipped: z.array(z.string()),
  reason,
})
export type WatchPathsSkipEvidence = z.infer<typeof watchPathsSkipEvidenceSchema>

// ---------------------------------------------------------------------------
// Support windows

/** A release line in endoflife.date and its support dates. */
export const supportLineSchema = z.object({
  /** endoflife.date product slug, for example `nodejs` or `nextjs`. */
  product: z.string(),
  /** Release name, for example `22` or `6.1`. */
  line: z.string(),
  /** End of security support (or of the cycle, see `basis`); null when none is announced. */
  eolFrom: day.nullable(),
  isEol: z.boolean(),
  /** End of active support (bug fixes only). Shown, never raises a level. */
  isEoas: z.boolean().nullable(),
  /** Latest version of the line, null when the data has none. */
  latest: z.string().nullable(),
  basis: supportBasisSchema,
  /** Days until `eolFrom` at scan time, negative when past, null without a date. */
  daysLeft: z.number().int().nullable(),
})
export type SupportLine = z.infer<typeof supportLineSchema>

/** A supported line to move to. */
export const supportTargetSchema = z.object({
  line: z.string(),
  latest: z.string().nullable(),
})
export type SupportTarget = z.infer<typeof supportTargetSchema>

/** One runtime pin as read from a file. */
export const runtimePinSchema = z.object({
  runtime: runtimeSchema,
  source: runtimePinSourceSchema,
  path: z.string(),
  line,
  /** The value as written, for example `22`, `node:22-alpine` or `>=20 <23`. */
  raw: z.string(),
  /** Resolved release name, null when it could not be resolved. */
  lineName: z.string().nullable(),
  /** `lts`, `latest`, `node`, `stable` and similar: resolved at scan time, never in the disagreement rule. */
  floating: z.boolean(),
})
export type RuntimePin = z.infer<typeof runtimePinSchema>

/** One edit that moves a pin to the target line. */
export const fixHintSchema = z.object({
  path: z.string(),
  line,
  from: z.string(),
  to: z.string(),
})
export type FixHint = z.infer<typeof fixHintSchema>

/** One installed framework matched to an endoflife.date product. */
export const frameworkEntrySchema = z.object({
  /** Package as in the lockfile, for example `next` or `laravel/framework`. */
  packageName: z.string(),
  ecosystem: z.string(),
  /** The purl that joined it to the product, for example `pkg:npm/next`. */
  purl: z.string(),
  installedVersion: z.string(),
  manifestPath: z.string().nullable(),
  result: guardResultSchema,
  /** Null when the version matches no release line (result `unknown`). */
  support: supportLineSchema.nullable(),
  target: supportTargetSchema.nullable(),
})
export type FrameworkEntry = z.infer<typeof frameworkEntrySchema>

export const frameworkSupportEvidenceSchema = z.object({
  check: z.literal('framework_support'),
  /** Branch or release tag the lockfile was read at. */
  ref: z.string().nullable(),
  /** Every matched framework; the finding's level is the worst result among them. */
  frameworks: z.array(frameworkEntrySchema),
  reason,
})
export type FrameworkSupportEvidence = z.infer<typeof frameworkSupportEvidenceSchema>

/** One runtime of a repo in the support check. */
export const runtimeSupportEntrySchema = z.object({
  runtime: runtimeSchema,
  result: guardResultSchema,
  /** The pin that decides what runs in production, by precedence. */
  pin: runtimePinSchema.nullable(),
  support: supportLineSchema.nullable(),
  /** Floating pins: the line it resolved to today. */
  resolvedTo: z.string().nullable(),
  target: supportTargetSchema.nullable(),
  fixHints: z.array(fixHintSchema),
})
export type RuntimeSupportEntry = z.infer<typeof runtimeSupportEntrySchema>

export const runtimeSupportEvidenceSchema = z.object({
  check: z.literal('runtime_support'),
  /** Branch or release tag the pins were read at. */
  ref: z.string().nullable(),
  /** One entry per runtime the repo pins; the finding's level is the worst result. */
  runtimes: z.array(runtimeSupportEntrySchema),
  reason,
})
export type RuntimeSupportEvidence = z.infer<typeof runtimeSupportEvidenceSchema>

export const runtimePinsEntrySchema = z.object({
  runtime: runtimeSchema,
  result: guardResultSchema,
  /** Line production runs on, null when no production pin was found. */
  productionLine: z.string().nullable(),
  /** Every pin of this runtime, the disagreeing ones included. */
  pins: z.array(runtimePinSchema),
  fixHints: z.array(fixHintSchema),
})
export type RuntimePinsEntry = z.infer<typeof runtimePinsEntrySchema>

export const runtimePinsDisagreeEvidenceSchema = z.object({
  check: z.literal('runtime_pins_disagree'),
  ref: z.string().nullable(),
  runtimes: z.array(runtimePinsEntrySchema),
  reason,
})
export type RuntimePinsDisagreeEvidence = z.infer<typeof runtimePinsDisagreeEvidenceSchema>

/** One action and the runtime it declares. */
export const actionRuntimeEntrySchema = z.object({
  /** `owner/repo@ref` (with a path for actions in a subfolder), or `self` for the repo's own action.yml. */
  action: z.string(),
  /** `runs.using` as written, for example `node20`. */
  using: z.string(),
  result: guardResultSchema,
  support: supportLineSchema.nullable(),
  /** Workflow file and line of the `uses:`; null for the repo's own action. */
  workflowPath: z.string().nullable(),
  workflowLine: line,
})
export type ActionRuntimeEntry = z.infer<typeof actionRuntimeEntrySchema>

export const actionRuntimeEvidenceSchema = z.object({
  check: z.literal('action_runtime'),
  actions: z.array(actionRuntimeEntrySchema),
  reason,
})
export type ActionRuntimeEvidence = z.infer<typeof actionRuntimeEvidenceSchema>

// ---------------------------------------------------------------------------

/** Evidence of any guard finding, told apart by `check`. */
export const guardEvidenceSchema = z.discriminatedUnion('check', [
  rootUserEvidenceSchema,
  sharedNetworkEvidenceSchema,
  dockerSocketEvidenceSchema,
  watchPathsSkipEvidenceSchema,
  frameworkSupportEvidenceSchema,
  runtimeSupportEvidenceSchema,
  runtimePinsDisagreeEvidenceSchema,
  actionRuntimeEvidenceSchema,
])
export type GuardEvidence = z.infer<typeof guardEvidenceSchema>
/** Evidence as a producer writes it (`reason` may be left out). */
export type GuardEvidenceInput = z.input<typeof guardEvidenceSchema>
