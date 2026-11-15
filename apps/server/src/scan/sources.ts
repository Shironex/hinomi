import type {
  AccountRepo,
  DependabotAlertsResult,
  RepoHealth,
  RuntimePinRecord,
} from '@hinomi/shared'
import { scanRuntimePins } from '../pins/index.js'
import { cachedFactsOf, type Repositories, type Source } from '../repository/index.js'
import {
  isScannedDeploymentSource,
  openDeploymentSource,
  type DeploymentSource,
  type ImageScanReader,
} from '../sources/deployments/index.js'
import {
  createGithubSourceFromConfig,
  readRepoFile,
  type ConditionalRead,
  type GithubRelease,
  type GithubSource,
} from '../sources/github/index.js'
import {
  createOsvClient,
  createRepoContents,
  fetchLockfiles,
  type FetchedLockfile,
} from '../sources/osv/index.js'
import type { OsvClient } from '../sources/osv/index.js'
import { createImageSbomReader, type ImageSbomReader } from '../sources/registry/index.js'
import { readScanSettings, type ScanSettings } from './settings.js'

export type { DeploymentSource, ImageSbomReader, ImageScanReader }

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
  /**
   * Every enabled deployment source (Coolify today), lowest id first. The deployments phase reads
   * each one's inventory through the same interface; see docs/sources.md.
   */
  deployments: DeploymentSource[]
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
  /**
   * Lists the file paths directly inside a folder of a repo at a ref through the given GitHub
   * source; null when the folder does not exist, throws when the read fails. Absent in hand-built
   * sources: guard checks that need it then say `unknown`.
   */
  listRepoDir?(
    owner: string,
    name: string,
    dir: string,
    ref: string,
    sourceId: number,
  ): Promise<string[] | null>
  /**
   * Reads the runtime pins of a repo at `ref` through the given GitHub source (anonymously when
   * it is null) and stores them, replacing the pins stored for that ref. Throws on a GitHub error
   * before anything is replaced. Absent in hand-built sources: no pins are read.
   */
  scanRuntimePins?(input: ScanPinsInput): Promise<RuntimePinRecord[]>
  /** Reads image SBOMs from registries (`sbom` image scan mode). Absent: that half is skipped. */
  imageSbom?: ImageSbomReader
  settings: ScanSettings
}

export interface ScanPinsInput {
  repoId: number
  owner: string
  name: string
  ref: string
  sourceId: number | null
  /** Repo relative paths of the Dockerfiles the repo's deployments build. */
  productionDockerfiles?: ReadonlySet<string>
  now: Date
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

  const deployments = repositories.sources
    .list()
    .filter(isScannedDeploymentSource)
    .flatMap((row) => {
      const source = openDeploymentSource(
        row,
        {
          getToken: (id) => repositories.sources.getToken(id),
          // Facts are read again only for resources that changed since the last scan.
          cachedFacts: (id) => cachedFactsOf(repositories.deployments.listBySource(id)),
        },
        { ...(options.fetch && { fetch: options.fetch }) },
      )
      return source ? [source] : []
    })

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
    deployments,
    github: [...github.values()].map((g) => g.github),
    osv,
    settings,
    // Makes no request until the `sbom` image scan mode asks for an image.
    imageSbom: createImageSbomReader({ ...(options.fetch && { fetch: options.fetch }) }),
    readRepoFile: async (owner, name, path, ref, sourceId) => {
      const gh = github.get(sourceId)
      if (!gh) throw new Error(`GitHub source ${sourceId} is not available`)
      return gh.readFile(owner, name, path, ref)
    },
    listRepoDir: async (owner, name, dir, ref, sourceId) => {
      const gh = github.get(sourceId)
      if (!gh) throw new Error(`GitHub source ${sourceId} is not available`)
      const entries = await createRepoContents(owner, name, ref, await gh.token(), {
        ...(options.fetch && { fetch: options.fetch }),
        ...(gh.apiUrl && { apiUrl: gh.apiUrl }),
      }).list(dir)
      return entries.length === 0
        ? null
        : entries.filter((e) => e.type === 'file').map((e) => e.path)
    },
    fetchLockfiles: async (owner, name, ref, sourceId) => {
      const gh = sourceId === null ? undefined : github.get(sourceId)
      return fetchLockfiles(owner, name, ref, gh ? await gh.token() : null, {
        ...(options.fetch && { fetch: options.fetch }),
        ...(gh?.apiUrl && { apiUrl: gh.apiUrl }),
      })
    },
    scanRuntimePins: async ({ sourceId, ...input }) => {
      const gh = sourceId === null ? undefined : github.get(sourceId)
      return scanRuntimePins(repositories.runtimePins, {
        ...input,
        token: gh ? await gh.token() : null,
        ...(options.fetch && { fetch: options.fetch }),
        ...(gh?.apiUrl && { apiUrl: gh.apiUrl }),
      })
    },
  }
}
