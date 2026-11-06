import {
  deploymentRecordSchema,
  type CoolifyConnectionConfig,
  type CoolifyConnectionTestResult,
  type DeploymentRecord,
} from '@hinomi/shared'
import { createCoolifyClient, type CoolifyClient, type CoolifyClientOptions } from './client.js'
import { CoolifyError } from './errors.js'
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
  Pick<CoolifyClientOptions, 'timeoutMs' | 'fetch'>

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
  const records = [
    ...applications.map((r) => applicationRecord(source, r, index)),
    ...services.map((r) => serviceRecord(source, r, index)),
    ...databases.map((r) => databaseRecord(source, r, index)),
  ]
  return records
    .filter((r): r is DeploymentRecord => r !== null)
    .map((r) => deploymentRecordSchema.parse(r))
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
