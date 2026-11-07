import {
  externalNetworkNames,
  parseCompose,
  parseDockerRunOptions,
  readDockerfileUser,
  type ContainerMount,
  type DeploymentFacts,
  type DeploymentKind,
  type FactKey,
  type FactMount,
  type FactNetwork,
  type FactService,
  type InlineDockerfileFact,
  type MountSource,
  type ProjectFact,
} from '@hinomi/shared'
import { asRecord, joinImage, str } from './normalize.js'

// Turns Coolify resource fields into deployment facts (docs/design/phase-2.md section 4).
// Pure: the caller fetches. Raw text (run options, compose, Dockerfile) is parsed here and
// dropped; only the parsed values reach the facts.

type Raw = Record<string, unknown>

/** Larger inline files are not parsed (and never stored). */
const MAX_TEXT_BYTES = 256 * 1024

/** `{ file_storages, persistent_storages }` of one resource, only the fields Hinomi reads. */
export interface CoolifyStorages {
  file: { hostPath: string | null; target: string | null; isDirectory: boolean | null }[]
  persistent: { name: string | null; hostPath: string | null; target: string | null }[]
  /** True when at least one persistent storage carried a `host_path` key (even null). */
  persistentHostPathReported: boolean
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(asRecord).filter((r): r is Raw => r !== null) : []
}

function hasKey(raw: Raw, key: string): boolean {
  return Object.hasOwn(raw, key)
}

/**
 * Reads the storages answer. The documented shape is `{ persistent_storages, file_storages }`;
 * a bare list (or `{ data: [...] }`) is split by `fs_path`, which only file storages have.
 * `host_path` is not in the OpenAPI spec, so it is read when present (snake or camel case)
 * and its absence is recorded. File storage `content` is never read.
 */
export function parseStorages(body: unknown): CoolifyStorages | null {
  const record = asRecord(body)
  let files: Raw[]
  let persistent: Raw[]
  if (record && (hasKey(record, 'persistent_storages') || hasKey(record, 'file_storages'))) {
    files = list(record.file_storages)
    persistent = list(record.persistent_storages)
  } else {
    const items = Array.isArray(body) ? body : record?.data
    if (!Array.isArray(items)) return null
    files = list(items).filter((s) => hasKey(s, 'fs_path'))
    persistent = list(items).filter((s) => !hasKey(s, 'fs_path'))
  }
  return {
    file: files.map((s) => ({
      hostPath: str(s.fs_path),
      target: str(s.mount_path),
      isDirectory: typeof s.is_directory === 'boolean' ? s.is_directory : null,
    })),
    persistent: persistent.map((s) => ({
      name: str(s.name),
      hostPath: str(s.host_path) ?? str(s.hostPath),
      target: str(s.mount_path),
    })),
    persistentHostPathReported: persistent.some(
      (s) => hasKey(s, 'host_path') || hasKey(s, 'hostPath'),
    ),
  }
}

/** Environment id to its project, from `/projects` and `/projects/{uuid}/environments`. */
export type ProjectIndex = Map<string, ProjectFact>

export function indexProjects(
  projects: readonly { project: Raw; environments: readonly Raw[] }[],
): ProjectIndex {
  const index: ProjectIndex = new Map()
  for (const { project, environments } of projects) {
    const key = str(project.uuid) ?? idText(project.id)
    if (!key) continue
    for (const env of environments) {
      const id = idText(env.id)
      if (id) index.set(id, { key, name: str(project.name), environment: str(env.name) })
    }
  }
  return index
}

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

function idNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return null
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  return null
}

/** Text small enough to parse; null when absent or too large (the gap says which). */
function boundedText(value: unknown): { text: string | null; tooLarge: boolean } {
  const text = typeof value === 'string' && value.trim() ? value : null
  if (text === null) return { text: null, tooLarge: false }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return { text: null, tooLarge: true }
  return { text, tooLarge: false }
}

/** Some Coolify versions hand the inline Dockerfile back base64 encoded. */
function decodeDockerfile(text: string): string {
  const trimmed = text.trim()
  if (/\s/.test(trimmed) || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return text
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  return /^\s*(#|ARG\b|FROM\b)/im.test(decoded) ? decoded : text
}

/** First line of a parser error, without the source excerpt that may follow it. */
function errorLine(message: string): string {
  return (message.split('\n')[0] ?? '').replace(/:\s*$/, '').slice(0, 200)
}

function mount(origin: MountSource, m: ContainerMount, service: string | null): FactMount {
  return { origin, type: m.type, source: m.source, target: m.target, readOnly: m.readOnly, service }
}

/** What a Dockerfile says about the container user, from its text (inline or fetched). */
export function readInlineDockerfile(text: string, target: string | null): InlineDockerfileFact {
  const reading = readDockerfileUser(decodeDockerfile(text), { target })
  return {
    kind: reading.kind,
    user: reading.user?.raw ?? null,
    line: reading.user?.line ?? reading.stage?.line ?? null,
    stage: reading.stage?.name ?? null,
    from: reading.stage?.from ?? null,
    baseImage: reading.baseImage?.raw ?? null,
    baseNonroot: reading.baseNonroot,
  }
}

export interface CoolifyFactsInput {
  kind: DeploymentKind
  /** The resource as Coolify returns it (list item, merged with the detail when one was read). */
  raw: Raw
  /** Null when Coolify did not list the storages (older version, or no permission). */
  storages: CoolifyStorages | null
  /** Null when the project index could not be read. */
  projects: ProjectIndex | null
  fetchedAt: Date
}

const BUILD_PACKS_WITHOUT_USER = 'this build pack does not say which user the container runs as'

/** Builds the facts of one Coolify application, service or database. */
export function buildCoolifyFacts(input: CoolifyFactsInput): DeploymentFacts {
  const { kind, raw, storages } = input
  const gaps: Partial<Record<FactKey, string>> = {}
  const settings = asRecord(raw.settings)
  const buildPack =
    kind === 'application' ? str(raw.build_pack) : kind === 'service' ? 'dockercompose' : null

  const mounts: FactMount[] = []
  const networks: FactNetwork[] = []
  const services: FactService[] = []
  let hostNetwork = false
  let privileged = false

  // Run options: every kind of resource can have them.
  const runText = boundedText(raw.custom_docker_run_options)
  const run = runText.text === null ? null : parseDockerRunOptions(runText.text)
  if (runText.tooLarge) {
    gaps.user = 'the custom run options are too large to read'
    gaps.mounts = gaps.user
  }
  if (run) {
    privileged ||= run.privileged
    for (const m of run.mounts) mounts.push(mount('run_options', m, null))
    for (const name of run.networks) {
      if (name === 'host') hostNetwork = true
      else if (name !== 'none' && name !== 'bridge')
        networks.push({ origin: 'run_options', name, service: null })
    }
  }

  // Compose: compose applications and every service.
  const usesCompose = buildPack === 'dockercompose'
  let composeRead = false
  if (usesCompose) {
    const composeText = boundedText(raw.docker_compose_raw)
    if (composeText.text === null) {
      gaps.user = composeText.tooLarge
        ? 'the compose file is too large to read'
        : 'Coolify returned no compose file for this resource'
      gaps.mounts = gaps.user
    } else {
      const parsed = parseCompose(composeText.text)
      if (!parsed.ok) {
        gaps.user = `the compose file could not be read: ${errorLine(parsed.error)}`
        gaps.mounts = gaps.user
      } else {
        composeRead = true
        for (const service of parsed.file.services) {
          services.push({
            name: service.name,
            user: service.user,
            image: service.image,
            build: service.build,
            privileged: service.privileged,
            networkMode: service.networkMode,
          })
          privileged ||= service.privileged
          if (service.networkMode === 'host') hostNetwork = true
          for (const m of service.volumes) mounts.push(mount('compose', m, service.name))
          for (const name of externalNetworkNames(parsed.file, service)) {
            networks.push({ origin: 'compose', name, service: service.name })
          }
        }
      }
    }
  }

  // Storages.
  const mountsChecked: MountSource[] = runText.tooLarge ? [] : ['run_options']
  if (composeRead) mountsChecked.push('compose')
  if (storages === null) {
    gaps.mounts ??= 'Coolify did not list the storages of this resource'
  } else {
    mountsChecked.push('file_storage')
    for (const f of storages.file) {
      if (!f.hostPath) continue
      mounts.push({
        origin: 'file_storage',
        type: 'bind',
        source: f.hostPath,
        target: f.target,
        readOnly: false,
        service: null,
      })
    }
    if (storages.persistent.length === 0 || storages.persistentHostPathReported) {
      mountsChecked.push('persistent_storage')
    } else {
      gaps.mounts ??=
        'Coolify did not report the host path of persistent storages, so only file storages, run options and compose were read'
    }
    for (const p of storages.persistent) {
      mounts.push({
        origin: 'persistent_storage',
        type: p.hostPath ? 'bind' : 'volume',
        source: p.hostPath ?? p.name,
        target: p.target,
        readOnly: false,
        service: null,
      })
    }
  }

  // Dockerfile.
  let dockerfile: DeploymentFacts['dockerfile'] = null
  if (buildPack === 'dockerfile') {
    const target = str(raw.dockerfile_target_build)
    const inlineText = boundedText(raw.dockerfile)
    if (inlineText.tooLarge) gaps.dockerfile = 'the inline Dockerfile is too large to read'
    dockerfile = {
      location: str(raw.dockerfile_location),
      baseDirectory: str(raw.base_directory),
      target,
      inline: inlineText.text === null ? null : readInlineDockerfile(inlineText.text, target),
    }
  }

  // The user: run options win; compose and Dockerfile apps carry their own signal.
  if (!run?.user && !gaps.user) {
    if (kind === 'database')
      gaps.user = 'Coolify does not say which user a managed database runs as'
    else if (!usesCompose && buildPack !== 'dockerfile') gaps.user = BUILD_PACKS_WITHOUT_USER
  }

  // Destination and network attachment.
  const destinationRecord = asRecord(raw.destination)
  const destinationId = idNumber(raw.destination_id) ?? idNumber(destinationRecord?.id)
  const destinationType = str(raw.destination_type)
  const server =
    idText(raw.server_id) ??
    idText(destinationRecord?.server_id) ??
    idText(asRecord(destinationRecord?.server)?.id) ??
    idText(asRecord(raw.server)?.id)
  const destination =
    destinationId === null && destinationType === null && server === null
      ? null
      : { server, typeName: destinationType, id: destinationId }
  if (destination === null || destination.id === null)
    gaps.destination = 'Coolify did not report the destination of this resource'

  let attachedToDestination: boolean | null
  if (kind === 'service') attachedToDestination = bool(raw.connect_to_docker_network)
  else if (usesCompose) attachedToDestination = bool(settings?.connect_to_docker_network)
  else attachedToDestination = true
  if (attachedToDestination === null) {
    gaps.networks =
      'Coolify did not say whether this compose resource joins the destination network'
  }

  // Project.
  const environmentId = idText(raw.environment_id)
  const project =
    environmentId !== null && input.projects ? (input.projects.get(environmentId) ?? null) : null
  if (!project) gaps.project = 'the project of this resource could not be read from Coolify'

  // Auto deploy (applications only).
  const autoDeploy = kind === 'application' ? bool(settings?.is_auto_deploy_enabled) : null
  if (kind === 'application' && autoDeploy === null)
    gaps.autoDeploy = 'Coolify did not report whether automatic deploys are on'

  const image =
    kind === 'database'
      ? str(raw.image)
      : buildPack === 'dockerimage'
        ? joinImage(raw.docker_registry_image_name, raw.docker_registry_image_tag)
        : null
  const sha = str(raw.git_commit_sha)

  return {
    version: 1,
    fetchedAt: input.fetchedAt.toISOString(),
    buildPack,
    image,
    commit: sha && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null,
    user: run?.user ?? null,
    services,
    dockerfile,
    mounts,
    mountsChecked,
    networks,
    hostNetwork,
    privileged,
    destination,
    attachedToDestination,
    project,
    autoDeploy,
    gaps,
  }
}
