import { currentTime, DOCKER_OPT_IN_LABEL, type DeploymentRecord } from '@hinomi/shared'
import { DockerError } from './errors.js'
import {
  containerName,
  factsOf,
  labelsOf,
  parseInspect,
  projectOfInspect,
  publishesPublicPort,
} from './facts.js'
import {
  branchFromLabels,
  commitFromLabels,
  composeOf,
  domainsFromLabels,
  repoFromLabels,
} from './labels.js'
import { containerListSchema, containerSummarySchema, type ContainerInspect } from './schemas.js'
import { isOwnContainer } from './self.js'
import type { DockerTransport } from './transport.js'

// The inventory of a Docker host (docs/design/phase-2.md section 9.3): list the containers (only
// the opted in ones by default), inspect each, and group compose replicas into one deployment per
// project and service. Reads `GET /containers/json` and `GET /containers/{id}/json` only.

/** More containers than this on one host are not read; the list is cut, never the scan. */
export const MAX_CONTAINERS = 500

export interface DockerInventoryOptions {
  transport: DockerTransport
  /** The source's name: set as `source` and as the server of every record. */
  name: string
  optIn: boolean
  /** Ids of Hinomi's own container, skipped. */
  ownIds?: readonly string[]
  now?: () => Date
}

export function containerListPath(optIn: boolean): string {
  const base = '/containers/json?all=1'
  if (!optIn) return base
  const filters = JSON.stringify({ label: [`${DOCKER_OPT_IN_LABEL}=true`] })
  return `${base}&filters=${encodeURIComponent(filters)}`
}

/** A container id as the list gives it; anything else is never put in a path. */
const CONTAINER_ID = /^[0-9a-f]{12,64}$/

/** The containers' ids, from the list answer. */
async function listIds(options: DockerInventoryOptions): Promise<string[]> {
  const raw = await options.transport.get(containerListPath(options.optIn))
  const list = containerListSchema.safeParse(raw)
  if (!list.success) {
    throw new DockerError('bad_response', 'The Docker API container list is not a list')
  }
  const ids: string[] = []
  for (const entry of list.data) {
    const summary = containerSummarySchema.safeParse(entry)
    if (!summary.success || !CONTAINER_ID.test(summary.data.Id)) continue
    if (isOwnContainer(summary.data.Id, options.ownIds ?? [])) continue
    ids.push(summary.data.Id)
    if (ids.length >= MAX_CONTAINERS) break
  }
  return ids
}

/** A container that has gone between the list and the inspect is skipped, not an error. */
async function inspect(transport: DockerTransport, id: string): Promise<ContainerInspect | null> {
  try {
    return parseInspect(await transport.get(`/containers/${id}/json`))
  } catch (error) {
    if (error instanceof DockerError && error.code === 'not_found') return null
    throw error
  }
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value || value.startsWith('0001-01-01')) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** `running`, or `running:healthy` when the container has a health check, like Coolify's. */
function statusOf(container: ContainerInspect): string {
  const state = container.State?.Status?.trim().toLowerCase()
  if (!state) return 'unknown'
  const health = container.State?.Health?.Status?.trim().toLowerCase()
  return health ? `${state}:${health}` : state
}

const RUNNING_FIRST = (a: ContainerInspect, b: ContainerInspect) =>
  Number(b.State?.Running === true) - Number(a.State?.Running === true) ||
  (a.Name ?? '').localeCompare(b.Name ?? '')

/** One deployment from the containers of one compose service (replicas), or one container. */
function recordOf(
  containers: ContainerInspect[],
  options: DockerInventoryOptions,
  fetchedAt: string,
): DeploymentRecord {
  const sorted = [...containers].sort(RUNNING_FIRST)
  const main = sorted[0]!
  const labels = labelsOf(main)
  const compose = composeOf(labels)
  const { repo, raw } = repoFromLabels(labels)
  const domains = domainsFromLabels(labels).domains
  const facts = factsOf(main, {
    fetchedAt,
    commit: commitFromLabels(labels),
    project: projectOfInspect(main),
  })
  // Replicas share a configuration; their mounts and networks are joined all the same.
  for (const other of sorted.slice(1)) {
    const more = factsOf(other, { fetchedAt, commit: null, project: facts.project!.key })
    for (const m of more.mounts) {
      if (!facts.mounts.some((x) => x.source === m.source && x.target === m.target)) {
        facts.mounts.push(m)
      }
    }
    for (const n of more.networks) {
      if (!facts.networks.some((x) => x.name === n.name)) facts.networks.push(n)
    }
    facts.hostNetwork ||= more.hostNetwork
    facts.privileged ||= more.privileged
  }
  const started = sorted.map((c) => isoOrNull(c.State?.StartedAt) ?? isoOrNull(c.Created))
  const lastDeployAt =
    started
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null

  return {
    source: options.name,
    externalId: compose
      ? `compose:${compose.project}/${compose.service}`
      : `container:${containerName(main)}`,
    name: compose ? `${compose.project}/${compose.service}` : containerName(main),
    kind: compose ? 'service' : 'application',
    repo,
    branch: branchFromLabels(labels),
    gitRepository: raw,
    domains,
    // A port published on every interface is reachable from outside, domain or not.
    isPublic:
      domains.some((d) => /^https?:\/\//.test(d)) || sorted.some((c) => publishesPublicPort(c)),
    server: options.name,
    status: statusOf(main),
    image: main.Config?.Image || null,
    lastDeployAt,
    watchPaths: null,
    facts,
    // Inspect is read on every scan: it is one cheap call per container.
    factsVersion: null,
  }
}

export async function fetchDockerInventory(
  options: DockerInventoryOptions,
): Promise<DeploymentRecord[]> {
  const fetchedAt = (options.now?.() ?? currentTime()).toISOString()
  const ids = await listIds(options)
  const groups = new Map<string, ContainerInspect[]>()
  for (const id of ids) {
    const container = await inspect(options.transport, id)
    if (!container || isOwnContainer(container.Id, options.ownIds ?? [])) continue
    const compose = composeOf(labelsOf(container))
    const key = compose ? `compose:${compose.project}/${compose.service}` : `id:${container.Id}`
    groups.set(key, [...(groups.get(key) ?? []), container])
  }
  const records = [...groups.values()].map((group) => recordOf(group, options, fetchedAt))
  // Two plain containers cannot share a name on one host, but keep ids unique all the same.
  const seen = new Set<string>()
  return records.filter((r) => !seen.has(r.externalId) && Boolean(seen.add(r.externalId)))
}
