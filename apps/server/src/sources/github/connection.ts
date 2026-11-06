import type { GithubConnection } from '@hinomi/shared'
import type { GithubClient } from './client.js'
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
