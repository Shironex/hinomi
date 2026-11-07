import type {
  AccountRepo,
  DependabotAlertsResult,
  GithubConnection,
  RepoHealth,
} from '@hinomi/shared'
import { fetchDependabotAlerts } from './alerts.js'
import { createGithubAppAuth, type GithubAppAuth, type GithubAppCredentials } from './app-auth.js'
import { createGithubClient, type GithubClient, type GithubClientOptions } from './client.js'
import {
  testGithubAppConnection,
  testGithubConnection,
  type GithubAppConnection,
} from './connection.js'
import { fetchLatestRelease, type GithubRelease } from './releases.js'
import { fetchRepoHealth, listAccountRepos, listInstallationRepos } from './repos.js'
import type { ConditionalRead } from './runs.js'

/** The functions bound to one client, which is what the scheduler and the settings API hold. */
export interface GithubSource {
  client: GithubClient
  testConnection(): Promise<GithubConnection>
  fetchRepoHealth(owner: string, name: string): Promise<RepoHealth>
  fetchDependabotAlerts(owner: string, name: string): Promise<DependabotAlertsResult>
  /** Token: the repos of the user and their orgs. GitHub App: the repos of the installation. */
  listAccountRepos(): Promise<AccountRepo[]>
  /** The latest final release, read with the last ETag (see releases.ts). */
  fetchLatestRelease(
    owner: string,
    name: string,
    etag: string | null,
  ): Promise<ConditionalRead<GithubRelease | null>>
  /** A bearer token for other GitHub calls (lockfile downloads). Minted on demand for an app. */
  getToken(): Promise<string>
}

export interface GithubAppSource extends GithubSource {
  app: GithubAppAuth
  testAppConnection(): Promise<GithubAppConnection>
}

export function createGithubSource(options: GithubClientOptions): GithubSource {
  const client = createGithubClient(options)
  const { token, auth } = options
  return {
    client,
    testConnection: () => testGithubConnection(client),
    fetchRepoHealth: (owner, name) => fetchRepoHealth(client, owner, name),
    fetchDependabotAlerts: (owner, name) => fetchDependabotAlerts(client, owner, name),
    listAccountRepos: () => listAccountRepos(client),
    fetchLatestRelease: (owner, name, etag) => fetchLatestRelease(client, owner, name, etag),
    getToken: () => (auth ? auth.getToken() : Promise.resolve(token ?? '')),
  }
}

export type GithubAppSourceOptions = GithubAppCredentials &
  Omit<GithubClientOptions, 'token' | 'auth'>

/** A source signed in as a GitHub App installation. `/user` endpoints do not apply to it. */
export function createGithubAppSource(options: GithubAppSourceOptions): GithubAppSource {
  const { appId, installationId, privateKey, ...clientOptions } = options
  const app = createGithubAppAuth({
    appId,
    installationId,
    privateKey,
    ...(clientOptions.baseUrl !== undefined && { baseUrl: clientOptions.baseUrl }),
    ...(clientOptions.fetch !== undefined && { fetch: clientOptions.fetch }),
    ...(clientOptions.timeoutMs !== undefined && { timeoutMs: clientOptions.timeoutMs }),
    ...(clientOptions.now !== undefined && { now: clientOptions.now }),
  })
  const source = createGithubSource({ ...clientOptions, auth: app })
  return {
    ...source,
    app,
    // An installation has no user: report the account it is installed on instead.
    testConnection: async () => {
      const connection = await testGithubAppConnection(source.client, app)
      return { login: connection.account, scopes: null }
    },
    testAppConnection: () => testGithubAppConnection(source.client, app),
    listAccountRepos: () => listInstallationRepos(source.client),
  }
}

/** How a stored GitHub source signs in, without its secret. */
export interface GithubSourceConfig {
  name: string
  auth: 'token' | 'github_app'
  baseUrl: string | null
  appId: string | null
  installationId: string | null
}

/**
 * The source for a stored config and its decrypted secret: the token, or the app's private key.
 * Throws when an app source lacks its App ID or installation ID.
 */
export function createGithubSourceFromConfig(
  config: GithubSourceConfig,
  secret: string,
  options: Omit<GithubClientOptions, 'token' | 'auth' | 'baseUrl'> = {},
): GithubSource | GithubAppSource {
  const shared = { ...options, ...(config.baseUrl && { baseUrl: config.baseUrl }) }
  if (config.auth !== 'github_app') return createGithubSource({ token: secret, ...shared })
  if (config.appId === null || config.installationId === null) {
    throw new Error(`GitHub source "${config.name}" is missing its App ID or installation ID`)
  }
  return createGithubAppSource({
    appId: config.appId,
    installationId: config.installationId,
    privateKey: secret,
    ...shared,
  })
}

/** True for a source signed in as a GitHub App installation. */
export function isGithubAppSource(source: GithubSource): source is GithubAppSource {
  return 'app' in source
}
