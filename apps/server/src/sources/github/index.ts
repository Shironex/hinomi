import type {
  AccountRepo,
  DependabotAlertsResult,
  GithubConnection,
  RepoHealth,
} from '@hinomi/shared'
import { fetchDependabotAlerts } from './alerts.js'
import { createGithubClient, type GithubClient, type GithubClientOptions } from './client.js'
import { testGithubConnection } from './connection.js'
import { fetchRepoHealth, listAccountRepos } from './repos.js'

export { createGithubClient } from './client.js'
export type { GithubClient, GithubClientOptions, RestOptions, RestResult } from './client.js'
export { GithubError, GithubRateLimitError, isGithubError } from './errors.js'
export type { GithubErrorKind } from './errors.js'
export { fetchDependabotAlerts } from './alerts.js'
export { fetchRepoHealth, listAccountRepos } from './repos.js'
export { testGithubConnection } from './connection.js'

/** The functions bound to one client, which is what the scheduler and the settings API hold. */
export interface GithubSource {
  client: GithubClient
  testConnection(): Promise<GithubConnection>
  fetchRepoHealth(owner: string, name: string): Promise<RepoHealth>
  fetchDependabotAlerts(owner: string, name: string): Promise<DependabotAlertsResult>
  listAccountRepos(): Promise<AccountRepo[]>
}

export function createGithubSource(options: GithubClientOptions): GithubSource {
  const client = createGithubClient(options)
  return {
    client,
    testConnection: () => testGithubConnection(client),
    fetchRepoHealth: (owner, name) => fetchRepoHealth(client, owner, name),
    fetchDependabotAlerts: (owner, name) => fetchDependabotAlerts(client, owner, name),
    listAccountRepos: () => listAccountRepos(client),
  }
}
