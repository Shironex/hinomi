import type {
  AccountRepo,
  DeploymentRecord,
  DependabotAlertsResult,
  RepoHealth,
} from '@hinomi/shared'
import type { Repositories, Source } from '../repository/index.js'
import { fetchCoolifyInventory } from '../sources/coolify/index.js'
import { createGithubSourceFromConfig, type GithubSource } from '../sources/github/index.js'
import { createOsvClient, fetchLockfiles, type FetchedLockfile } from '../sources/osv/index.js'
import type { OsvClient } from '../sources/osv/index.js'
import { readScanSettings, type ScanSettings } from './settings.js'

export interface CoolifyScanSource {
  sourceId: number
  name: string
  fetchInventory(): Promise<DeploymentRecord[]>
}

export interface GithubScanSource {
  sourceId: number
  name: string
  fetchRepoHealth(owner: string, name: string): Promise<RepoHealth>
  fetchDependabotAlerts(owner: string, name: string): Promise<DependabotAlertsResult>
  listAccountRepos(): Promise<AccountRepo[]>
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
  return {
    sourceId: source.id,
    name: source.name,
    fetchInventory: async () => {
      if (!source.baseUrl) throw new Error(`Coolify source "${source.name}" has no URL`)
      return fetchCoolifyInventory({
        name: source.name,
        baseUrl: source.baseUrl,
        token: token(),
        ...(options.fetch && { fetch: options.fetch }),
      })
    },
  }
}

function githubSource(
  repositories: Repositories,
  source: Source,
  options: BuildScanSourcesOptions,
): { github: GithubScanSource; token: () => Promise<string>; apiUrl: string | null } {
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
    github: {
      sourceId: source.id,
      name: source.name,
      fetchRepoHealth: async (owner, name) => client().fetchRepoHealth(owner, name),
      fetchDependabotAlerts: async (owner, name) => client().fetchDependabotAlerts(owner, name),
      listAccountRepos: async () => client().listAccountRepos(),
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
    fetchLockfiles: async (owner, name, ref, sourceId) => {
      const gh = sourceId === null ? undefined : github.get(sourceId)
      return fetchLockfiles(owner, name, ref, gh ? await gh.token() : null, {
        ...(options.fetch && { fetch: options.fetch }),
        ...(gh?.apiUrl && { apiUrl: gh.apiUrl }),
      })
    },
  }
}
