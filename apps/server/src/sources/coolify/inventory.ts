import {
  currentTime,
  deploymentRecordSchema,
  type CoolifyConnectionConfig,
  type CoolifyConnectionTestResult,
  type DeploymentFacts,
  type DeploymentKind,
  type DeploymentRecord,
} from '@hinomi/shared'
import { mapLimit } from '../osv/index.js'
import { createCoolifyClient, type CoolifyClient, type CoolifyClientOptions } from './client.js'
import { CoolifyError } from './errors.js'
import {
  buildCoolifyFacts,
  indexProjects,
  parseStorages,
  type CoolifyStorages,
  type ProjectIndex,
} from './facts.js'
import {
  asRecord,
  hasPublicDomain,
  joinImage,
  normalizeRepo,
  parseDomains,
  parseWatchPaths,
  str,
  toIso,
} from './normalize.js'

export type CoolifyOptions = CoolifyConnectionConfig &
  Pick<CoolifyClientOptions, 'timeoutMs' | 'fetch'> & { facts?: CoolifyFactsOptions }

/** What is stored for a deployment from an earlier read. */
export interface CachedFacts {
  /** The resource's `updated_at` the facts were read at; null forces a read. */
  version: string | null
  facts: DeploymentFacts | null
}

export interface CoolifyFactsOptions {
  /** Facts stored for a resource by its uuid, undefined when none are. */
  cached?: (externalId: string) => CachedFacts | undefined
  now?: () => Date
  /**
   * Facts older than this are read again even when `updated_at` did not move: adding a
   * storage does not touch the resource's `updated_at`. Defaults to 24 h.
   */
  maxAgeMs?: number
  /** Resources read in parallel. Defaults to 4. */
  concurrency?: number
}

const DEFAULT_FACTS_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_FACTS_CONCURRENCY = 4

type Raw = Record<string, unknown>

/** Lists come back as a bare array, or wrapped in `{ data: [...] }` on some versions. */
function toList(body: unknown, path: string): Raw[] {
  const list = Array.isArray(body) ? body : asRecord(body)?.data
  if (!Array.isArray(list)) {
    throw new CoolifyError('invalid_response', `Coolify returned an unexpected shape for ${path}`)
  }
  return list.map(asRecord).filter((r): r is Raw => r !== null)
}

async function fetchList(client: CoolifyClient, path: string, optional = false): Promise<Raw[]> {
  try {
    return toList(await client.getJson(path), path)
  } catch (err) {
    // Older versions do not have every endpoint.
    if (optional && err instanceof CoolifyError && err.code === 'not_found') return []
    throw err
  }
}

type ServerIndex = Map<string, string>

function indexServers(servers: Raw[]): ServerIndex {
  const byKey: ServerIndex = new Map()
  for (const s of servers) {
    const name = str(s.name)
    if (!name) continue
    for (const key of [s.id, s.uuid]) {
      if (typeof key === 'number' || typeof key === 'string') byKey.set(String(key), name)
    }
  }
  return byKey
}

function serverName(raw: Raw, servers: ServerIndex): string | null {
  const destination = asRecord(raw.destination)
  const nested = str(asRecord(raw.server)?.name) ?? str(asRecord(destination?.server)?.name)
  if (nested) return nested
  const direct = str(raw.server_name)
  if (direct) return direct
  const id = raw.server_id ?? asRecord(raw.server)?.id ?? destination?.server_id
  if (typeof id === 'number' || typeof id === 'string') return servers.get(String(id)) ?? null
  return null
}

function base(
  source: string,
  raw: Raw,
  kind: DeploymentRecord['kind'],
  servers: ServerIndex,
): DeploymentRecord | null {
  const externalId = str(raw.uuid)
  if (!externalId) return null
  const domains = parseDomains(raw.fqdn)
  return {
    source,
    externalId,
    name: str(raw.name) ?? externalId,
    kind,
    repo: null,
    branch: null,
    gitRepository: null,
    domains,
    isPublic: hasPublicDomain(domains),
    server: serverName(raw, servers),
    status: str(raw.status) ?? 'unknown',
    image: null,
    // Coolify exposes no dedicated field, updated_at moves on every deploy.
    lastDeployAt: toIso(raw.last_deployed_at) ?? toIso(raw.updated_at),
    watchPaths: null,
  }
}

function applicationRecord(
  source: string,
  raw: Raw,
  servers: ServerIndex,
): DeploymentRecord | null {
  const b = base(source, raw, 'application', servers)
  if (!b) return null
  return {
    ...b,
    repo: normalizeRepo(raw.git_repository),
    branch: str(raw.git_branch),
    // Services have no git source in the API; an app has one when this is set.
    gitRepository: str(raw.git_repository),
    image: joinImage(raw.docker_registry_image_name, raw.docker_registry_image_tag),
    watchPaths: parseWatchPaths(raw.watch_paths),
  }
}

function serviceRecord(source: string, raw: Raw, servers: ServerIndex): DeploymentRecord | null {
  const b = base(source, raw, 'service', servers)
  if (!b) return null
  // The sub-applications of a compose service carry the domains and images.
  const children = Array.isArray(raw.applications) ? raw.applications.map(asRecord) : []
  const domains = new Set(b.domains)
  const images: string[] = []
  for (const child of children) {
    if (!child) continue
    for (const d of parseDomains(child.fqdn)) domains.add(d)
    const image = str(child.image)
    if (image && !images.includes(image)) images.push(image)
  }
  const all = [...domains]
  return { ...b, domains: all, isPublic: hasPublicDomain(all), image: images.join(', ') || null }
}

function databaseRecord(source: string, raw: Raw, servers: ServerIndex): DeploymentRecord | null {
  const b = base(source, raw, 'database', servers)
  return b && { ...b, image: str(raw.image) }
}

/**
 * Read applications, services and databases of one Coolify instance and normalise them.
 * Records without a uuid are skipped. Throws CoolifyError on transport or auth failures.
 */
export async function fetchCoolifyInventory(options: CoolifyOptions): Promise<DeploymentRecord[]> {
  const client = createCoolifyClient(options)
  const [applications, services, servers, databases] = await Promise.all([
    fetchList(client, '/applications'),
    fetchList(client, '/services'),
    fetchList(client, '/servers'),
    fetchList(client, '/databases', true),
  ])
  const index = indexServers(servers)
  const source = options.name
  const resources: Resource[] = [
    ...applications.map((raw) => ({ raw, record: applicationRecord(source, raw, index) })),
    ...services.map((raw) => ({ raw, record: serviceRecord(source, raw, index) })),
    ...databases.map((raw) => ({ raw, record: databaseRecord(source, raw, index) })),
  ].filter((r): r is Resource => r.record !== null)
  const withFacts = await readFacts(client, resources, options.facts ?? {})
  return withFacts.map((r) => deploymentRecordSchema.parse(r))
}

interface Resource {
  raw: Raw
  record: DeploymentRecord
}

const STORAGE_PATHS: Record<DeploymentKind, string> = {
  application: 'applications',
  service: 'services',
  database: 'databases',
}

/** Errors that say nothing about the resource itself: keep what was stored and retry next scan. */
function isTransient(err: CoolifyError): boolean {
  return err.code === 'timeout' || err.code === 'network' || err.code === 'server_error'
}

/** Environment id to project, one call per project. Null when Coolify cannot list them. */
async function readProjects(client: CoolifyClient): Promise<ProjectIndex | null> {
  try {
    const projects = await fetchList(client, '/projects')
    const withEnvironments = await mapLimit(
      projects,
      DEFAULT_FACTS_CONCURRENCY,
      async (project) => {
        if (Array.isArray(project.environments)) {
          return {
            project,
            environments: project.environments.map(asRecord).filter((e) => e !== null),
          }
        }
        const uuid = str(project.uuid)
        if (!uuid) return { project, environments: [] }
        const environments = await fetchList(
          client,
          `/projects/${encodeURIComponent(uuid)}/environments`,
          true,
        )
        return { project, environments }
      },
    )
    return indexProjects(withEnvironments)
  } catch (err) {
    if (err instanceof CoolifyError) return null
    throw err
  }
}

/**
 * Adds facts to each record. A resource is read again (settings and storages) only when its
 * `updated_at` moved since the stored facts, or they are older than `maxAgeMs`; otherwise the
 * stored facts are passed on as they are. Projects are listed only when something is read.
 * Failures on one resource never fail the inventory: the facts get a gap instead.
 */
async function readFacts(
  client: CoolifyClient,
  resources: readonly Resource[],
  options: CoolifyFactsOptions,
): Promise<DeploymentRecord[]> {
  const now = options.now?.() ?? currentTime()
  const maxAge = options.maxAgeMs ?? DEFAULT_FACTS_MAX_AGE_MS
  const fresh = (r: Resource): CachedFacts | null => {
    const cached = options.cached?.(r.record.externalId)
    const version = str(r.raw.updated_at)
    if (!cached?.facts || cached.version === null || cached.version !== version) return null
    const age = now.getTime() - Date.parse(cached.facts.fetchedAt)
    return Number.isFinite(age) && age >= 0 && age < maxAge ? cached : null
  }

  const stale = resources.filter((r) => fresh(r) === null)
  const projects = stale.length > 0 ? await readProjects(client) : null

  return mapLimit(resources, options.concurrency ?? DEFAULT_FACTS_CONCURRENCY, async (r) => {
    const cached = fresh(r)
    if (cached) return { ...r.record, facts: cached.facts, factsVersion: cached.version }

    const { kind, externalId } = r.record
    const uuid = encodeURIComponent(externalId)
    let transient = false
    const soft = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read()
      } catch (err) {
        if (!(err instanceof CoolifyError)) throw err
        if (isTransient(err)) transient = true
        return null
      }
    }

    let raw = r.raw
    // The list may leave out `settings` (auto deploy, compose network); the detail has it.
    if (kind === 'application' && asRecord(raw.settings) === null) {
      const detail = await soft(async () => asRecord(await client.getJson(`/applications/${uuid}`)))
      if (detail) raw = { ...raw, ...detail }
    }
    const storages: CoolifyStorages | null = await soft(async () =>
      parseStorages(await client.getJson(`/${STORAGE_PATHS[kind]}/${uuid}/storages`)),
    )

    const previous = options.cached?.(externalId)
    if (transient && previous?.facts) {
      return { ...r.record, facts: previous.facts, factsVersion: null }
    }
    const facts = buildCoolifyFacts({ kind, raw, storages, projects, fetchedAt: now })
    return { ...r.record, facts, factsVersion: transient ? null : str(r.raw.updated_at) }
  })
}

/** Onboarding check: verifies URL and token. Never throws, returns the failure instead. */
export async function testCoolifyConnection(
  options: Omit<CoolifyOptions, 'name'>,
): Promise<CoolifyConnectionTestResult> {
  try {
    const client = createCoolifyClient(options)
    // /servers needs a valid token, /version alone may be public on some setups.
    await fetchList(client, '/servers')
    let version: string | null = null
    try {
      version = (await client.getText('/version')).replace(/^"|"$/g, '') || null
    } catch (err) {
      if (!(err instanceof CoolifyError) || err.code === 'unauthorized') throw err
    }
    return { ok: true, version }
  } catch (err) {
    if (err instanceof CoolifyError) return { ok: false, code: err.code, message: err.message }
    return { ok: false, code: 'network', message: 'Unexpected error while testing the connection' }
  }
}
