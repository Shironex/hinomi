import type {
  AccountRepo,
  DeploymentRecord,
  DependabotAlertsResult,
  RepoHealth,
} from '@hinomi/shared'
import type { Repositories, Source } from '../repository/index.js'
import { fetchCoolifyInventory } from '../sources/coolify/index.js'
import {
  createGithubAppSource,
  createGithubSource,
  type GithubSource,
} from '../sources/github/index.js'
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
  /** Null when no GitHub source is connected: no health or alerts, lockfiles only for public repos. */
  github: GithubScanSource | null
  /** Null when OSV is switched off. */
  osv: OsvScanSource | null
  fetchLockfiles(owner: string, name: string, ref: string): Promise<FetchedLockfile[]>
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
): { github: GithubScanSource; token: () => Promise<string> } {
  const secret = readToken(repositories, source)
  let bound: GithubSource | null = null
  const client = (): GithubSource => {
    if (bound) return bound
    const shared = {
      ...(source.baseUrl && { baseUrl: source.baseUrl }),
      ...(options.fetch && { fetch: options.fetch }),
    }
    if (source.auth === 'github_app') {
      if (source.appId === null || source.installationId === null) {
        throw new Error(`GitHub source "${source.name}" is missing its App ID or installation ID`)
      }
      // One app auth per scan: the installation token is minted once and reused until it expires.
      bound = createGithubAppSource({
        appId: source.appId,
        installationId: source.installationId,
        privateKey: secret(),
        ...shared,
      })
    } else {
      bound = createGithubSource({ token: secret(), ...shared })
    }
    return bound
  }
  return {
    token: async () => client().getToken(),
    github: {
      sourceId: source.id,
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

  const githubRow = enabled('github').find((s) => s.hasToken)
  const gh = githubRow ? githubSource(repositories, githubRow, options) : null

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
    github: gh?.github ?? null,
    osv,
    settings,
    fetchLockfiles: async (owner, name, ref) =>
      fetchLockfiles(owner, name, ref, gh ? await gh.token() : null, {
        ...(options.fetch && { fetch: options.fetch }),
        ...(githubRow?.baseUrl && { apiUrl: githubRow.baseUrl }),
      }),
  }
}
