import type { AccountRepo, RepoHealth, RepoVisibility } from '@hinomi/shared'
import { z } from 'zod'
import type { GithubClient } from './client.js'
import { GithubError } from './errors.js'
import { parsePayload, restRepoSchema, type RestRepo } from './schemas.js'

const MAX_PAGES = 100

function visibilityOf(repo: RestRepo): RepoVisibility {
  if (
    repo.visibility === 'public' ||
    repo.visibility === 'private' ||
    repo.visibility === 'internal'
  ) {
    return repo.visibility
  }
  return repo.private === false ? 'public' : 'private'
}

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/**
 * Repo metadata plus whether Dependabot alerts are on. `alertsEnabled` is null when the token
 * may not read the setting (403), which callers must treat as a blind spot and not as disabled.
 */
export async function fetchRepoHealth(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<RepoHealth> {
  const base = repoPath(owner, name)
  const [repoResult, alertsResult] = await Promise.all([
    client.rest(base),
    client.rest(`${base}/vulnerability-alerts`, { acceptStatus: [404, 403] }),
  ])
  const repo = parsePayload(restRepoSchema, repoResult.data, 'repository')

  let alertsEnabled: boolean | null
  if (alertsResult.status === 204) alertsEnabled = true
  else if (alertsResult.status === 404) alertsEnabled = false
  else if (alertsResult.status === 403) alertsEnabled = null
  else {
    throw new GithubError('http', `Unexpected ${alertsResult.status} from vulnerability-alerts`, {
      status: alertsResult.status,
    })
  }

  return {
    owner: repo.owner.login,
    name: repo.name,
    archived: repo.archived,
    defaultBranch: repo.default_branch ?? '',
    visibility: visibilityOf(repo),
    alertsEnabled,
    pushedAt: repo.pushed_at ?? null,
  }
}

function nextLink(header: string | null): string | null {
  if (header === null) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return null
}

/** Every repo the token can see through its user, collaborations and organizations. */
export async function listAccountRepos(client: GithubClient): Promise<AccountRepo[]> {
  const repos: AccountRepo[] = []
  let path: string | null =
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'
  for (let page = 0; path !== null && page < MAX_PAGES; page++) {
    const result = await client.rest(path)
    const items = parsePayload(z.array(restRepoSchema), result.data, 'repository list')
    for (const repo of items) {
      repos.push({
        owner: repo.owner.login,
        name: repo.name,
        archived: repo.archived,
        fork: repo.fork ?? false,
        defaultBranch: repo.default_branch ?? null,
        visibility: visibilityOf(repo),
        pushedAt: repo.pushed_at ?? null,
      })
    }
    const next = nextLink(result.headers.get('link'))
    // The Link header carries an absolute URL, the client wants a path.
    path = next === null ? null : toPath(next)
  }
  return repos
}

function toPath(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}
