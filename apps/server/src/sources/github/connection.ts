import type { GithubConnection } from '@hinomi/shared'
import { missingAppPermissions, type GithubAppAuth } from './app-auth.js'
import type { GithubClient } from './client.js'
import { countInstallationRepos } from './repos.js'
import { parsePayload, restUserSchema } from './schemas.js'

/** Verifies the token. Throws a `GithubError` of kind `auth` when it is rejected. */
export async function testGithubConnection(client: GithubClient): Promise<GithubConnection> {
  const result = await client.rest('/user')
  const user = parsePayload(restUserSchema, result.data, 'user')
  const header = result.headers.get('x-oauth-scopes')
  const scopes =
    header === null
      ? null
      : header
          .split(',')
          .map((scope) => scope.trim())
          .filter((scope) => scope !== '')
  return { login: user.login, scopes }
}

export interface GithubAppConnection {
  /** The user or organization the app is installed on. */
  account: string
  repositorySelection: 'all' | 'selected'
  repoCount: number
  /** Required permissions the installation lacks, empty when all are granted. */
  missingPermissions: string[]
  /** Administration (read) lets Hinomi see whether Dependabot alerts are on; optional. */
  canReadAlertSetting: boolean
}

/**
 * Verifies the app credentials end to end: mints an installation token (JWT and installation id),
 * reads the installation, and counts the repos the token can reach.
 */
export async function testGithubAppConnection(
  client: GithubClient,
  auth: GithubAppAuth,
): Promise<GithubAppConnection> {
  await auth.getToken()
  const installation = await auth.installation()
  const repoCount = await countInstallationRepos(client)
  const admin = installation.permissions.administration
  return {
    account: installation.account,
    repositorySelection: installation.repositorySelection,
    repoCount,
    missingPermissions: missingAppPermissions(installation.permissions),
    canReadAlertSetting: admin === 'read' || admin === 'write',
  }
}
