import type {
  AccountRepo,
  DeploymentKind,
  DeploymentRecord,
  DependabotAlertsResult,
  RepoHealth,
} from '@hinomi/shared'
import { cachedFactsOf, type Repositories, type Source } from '../repository/index.js'
import {
  createCoolifyClient,
  fetchCoolifyInventory,
  fetchResourceScan,
  probeImageScan,
  type CoolifyClient,
  type ImageScanProbe,
  type ResourceScanResult,
} from '../sources/coolify/index.js'
import {
  createGithubSourceFromConfig,
  readRepoFile,
  type ConditionalRead,
  type GithubRelease,
  type GithubSource,
} from '../sources/github/index.js'
import { createOsvClient, fetchLockfiles, type FetchedLockfile } from '../sources/osv/index.js'
import type { OsvClient } from '../sources/osv/index.js'
import { readScanSettings, type ScanSettings } from './settings.js'

/** Reads a deployment source's own image scan results (see image-scan.ts). */
export interface ImageScanReader {
  /** Once per instance and scan: whether it has results at all. */
  probe(): Promise<ImageScanProbe>
  /** One resource's images and findings, by its id in the source. */
  resource(kind: DeploymentKind, externalId: string): Promise<ResourceScanResult>
}

export interface CoolifyScanSource {
  sourceId: number
  name: string
  fetchInventory(): Promise<DeploymentRecord[]>
  /** Coolify's image scan results; left out by sources that cannot read them. */
  imageScan?: ImageScanReader
}

export interface GithubScanSource {
  sourceId: number
  name: string
  fetchRepoHealth(owner: string, name: string): Promise<RepoHealth>
  fetchDependabotAlerts(owner: string, name: string): Promise<DependabotAlertsResult>
  listAccountRepos(): Promise<AccountRepo[]>
  /** The repo's latest final release, read with the last ETag (the desktop release tier). */
  fetchLatestRelease(
    owner: string,
    name: string,
    etag: string | null,
  ): Promise<ConditionalRead<GithubRelease | null>>
}

export interface OsvScanSource {
  /** The osv row in `sources`, if one exists, to record its last error. */
  sourceId: number | null
  client: OsvClient
}

/**
 * Everything a scan talks to, already bound to tokens. `buildScanSources`
 * makes it from storage; tests can hand-build it.
 */
export interface ScanSources {
  coolify: CoolifyScanSource[]
  /**
   * Every enabled GitHub source with a credential, lowest id first. Each repo is read through
   * one of them (see ownership.ts). Empty: no health or alerts, lockfiles only for public repos.
   */
  github: GithubScanSource[]
  /** Null when OSV is switched off. */
  osv: OsvScanSource | null
  /** Reads lockfiles through the given GitHub source, or anonymously when it is null. */
  fetchLockfiles(
    owner: string,
    name: string,
    ref: string,
    sourceId: number | null,
  ): Promise<FetchedLockfile[]>
  /**
   * Reads one text file of a repo at a ref through the given GitHub source; null when the file
   * does not exist, throws when the read fails. Absent in hand-built sources: guard checks that
   * need a repo file then say `unknown`.
   */
  readRepoFile?(
    owner: string,
    name: string,
    path: string,
    ref: string,
    sourceId: number,
  ): Promise<string | null>
  settings: ScanSettings
}

export interface BuildScanSourcesOptions {
  fetch?: typeof fetch
  /** Overrides for the OSV client (base URL, retries) in tests. */
  osvBaseUrl?: string
  osvMaxRetries?: number
}

/** A token that cannot be read becomes an error on first use, recorded like any source error. */
function readToken(repositories: Repositories, source: Source): () => string {
  let token: string | null
  let failure: Error | null = null
  try {
    token = repositories.sources.getToken(source.id)
  } catch (error) {
    token = null
    failure = error instanceof Error ? error : new Error(String(error))
  }
  return () => {
    if (failure) throw failure
    if (!token) throw new Error(`${source.kind} source "${source.name}" has no token`)
    return token
  }
}

function coolifySource(
  repositories: Repositories,
  source: Source,
  options: BuildScanSourcesOptions,
): CoolifyScanSource {
  const token = readToken(repositories, source)
  let client: CoolifyClient | null = null
  const imageClient = (): CoolifyClient => {
    if (!source.baseUrl) throw new Error(`Coolify source "${source.name}" has no URL`)
    client ??= createCoolifyClient({
      baseUrl: source.baseUrl,
      token: token(),
      ...(options.fetch && { fetch: options.fetch }),
    })
    return client
  }
  return {
    sourceId: source.id,
    name: source.name,
    imageScan: {
      probe: async () => probeImageScan(imageClient()),
      resource: async (kind, externalId) => fetchResourceScan(imageClient(), kind, externalId),
    },
    fetchInventory: async () => {
      if (!source.baseUrl) throw new Error(`Coolify source "${source.name}" has no URL`)
      // Facts are read again only for resources that changed since the last scan.
      const cached = cachedFactsOf(repositories.deployments.listBySource(source.id))
      return fetchCoolifyInventory({
        name: source.name,
        baseUrl: source.baseUrl,
        token: token(),
        ...(options.fetch && { fetch: options.fetch }),
        facts: { cached: (externalId) => cached.get(externalId) },
      })
    },
  }
}

function githubSource(
  repositories: Repositories,
  source: Source,
  options: BuildScanSourcesOptions,
): {
  github: GithubScanSource
  token: () => Promise<string>
  apiUrl: string | null
  readFile: (owner: string, name: string, path: string, ref: string) => Promise<string | null>
} {
  const secret = readToken(repositories, source)
  let bound: GithubSource | null = null
  const client = (): GithubSource => {
    // One source per scan: an app's installation token is minted once and reused until it expires.
    bound ??= createGithubSourceFromConfig(source, secret(), {
      ...(options.fetch && { fetch: options.fetch }),
    })
    return bound
  }
  return {
    token: async () => client().getToken(),
    apiUrl: source.baseUrl,
    readFile: async (owner, name, path, ref) =>
      readRepoFile(client().client, owner, name, path, ref),
    github: {
      sourceId: source.id,
      name: source.name,
      fetchRepoHealth: async (owner, name) => client().fetchRepoHealth(owner, name),
      fetchDependabotAlerts: async (owner, name) => client().fetchDependabotAlerts(owner, name),
      listAccountRepos: async () => client().listAccountRepos(),
      fetchLatestRelease: async (owner, name, etag) =>
        client().fetchLatestRelease(owner, name, etag),
    },
  }
}

/** Reads the connected, enabled sources and the scan settings from storage. */
export function buildScanSources(
  repositories: Repositories,
  options: BuildScanSourcesOptions = {},
): ScanSources {
  const settings = readScanSettings(repositories.settings)
  const enabled = (kind: Source['kind']) =>
    repositories.sources.listByKind(kind).filter((s) => s.enabled)

  const coolify = enabled('coolify')
    .filter((s) => s.hasToken)
    .map((s) => coolifySource(repositories, s, options))

  const github = new Map(
    enabled('github')
      .filter((s) => s.hasToken)
      .map((s) => [s.id, githubSource(repositories, s, options)] as const),
  )

  const osvRows = repositories.sources.listByKind('osv')
  const osvOn = settings.osvEnabled && osvRows.every((s) => s.enabled)
  const osv: OsvScanSource | null = osvOn
    ? {
        sourceId: osvRows[0]?.id ?? null,
        client: createOsvClient({
          ...(options.fetch && { fetch: options.fetch }),
          ...(options.osvBaseUrl && { baseUrl: options.osvBaseUrl }),
          ...(options.osvMaxRetries !== undefined && { maxRetries: options.osvMaxRetries }),
        }),
      }
    : null

  return {
    coolify,
    github: [...github.values()].map((g) => g.github),
    osv,
    settings,
    readRepoFile: async (owner, name, path, ref, sourceId) => {
      const gh = github.get(sourceId)
      if (!gh) throw new Error(`GitHub source ${sourceId} is not available`)
      return gh.readFile(owner, name, path, ref)
    },
    fetchLockfiles: async (owner, name, ref, sourceId) => {
      const gh = sourceId === null ? undefined : github.get(sourceId)
      return fetchLockfiles(owner, name, ref, gh ? await gh.token() : null, {
        ...(options.fetch && { fetch: options.fetch }),
        ...(gh?.apiUrl && { apiUrl: gh.apiUrl }),
      })
    },
  }
}
