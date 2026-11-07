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
import { fetchRepoHealth, listAccountRepos, listInstallationRepos } from './repos.js'

/** The functions bound to one client, which is what the scheduler and the settings API hold. */
export interface GithubSource {
  client: GithubClient
  testConnection(): Promise<GithubConnection>
  fetchRepoHealth(owner: string, name: string): Promise<RepoHealth>
  fetchDependabotAlerts(owner: string, name: string): Promise<DependabotAlertsResult>
  /** Token: the repos of the user and their orgs. GitHub App: the repos of the installation. */
  listAccountRepos(): Promise<AccountRepo[]>
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
