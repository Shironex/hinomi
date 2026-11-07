export { createGithubClient } from './client.js'
export type {
  GithubClient,
  GithubClientOptions,
  GithubTokenProvider,
  RestOptions,
  RestResult,
} from './client.js'
export { GithubError, GithubRateLimitError, isGithubError } from './errors.js'
export type { GithubErrorKind } from './errors.js'
export { fetchDependabotAlerts } from './alerts.js'
export {
  countInstallationRepos,
  fetchRepoHealth,
  listAccountRepos,
  listInstallationRepos,
} from './repos.js'
export { testGithubAppConnection, testGithubConnection } from './connection.js'
export type { GithubAppConnection } from './connection.js'
export {
  createAppJwt,
  createGithubAppAuth,
  missingAppPermissions,
  readAppPrivateKey,
  REQUIRED_APP_PERMISSIONS,
} from './app-auth.js'
export type {
  GithubAppAuth,
  GithubAppAuthOptions,
  GithubAppCredentials,
  GithubInstallation,
} from './app-auth.js'
export {
  createGithubAppSource,
  createGithubSource,
  createGithubSourceFromConfig,
  isGithubAppSource,
  type GithubAppSource,
  type GithubAppSourceOptions,
  type GithubSource,
  type GithubSourceConfig,
} from './source.js'
