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

function toAccountRepo(repo: RestRepo): AccountRepo {
  return {
    owner: repo.owner.login,
    name: repo.name,
    archived: repo.archived,
    fork: repo.fork ?? false,
    defaultBranch: repo.default_branch ?? null,
    visibility: visibilityOf(repo),
    pushedAt: repo.pushed_at ?? null,
  }
}

/** Follows the Link header from `first`, reading each page's repos with `read`. */
async function listPaged(
  client: GithubClient,
  first: string,
  read: (data: unknown) => RestRepo[],
): Promise<AccountRepo[]> {
  const repos: AccountRepo[] = []
  let path: string | null = first
  for (let page = 0; path !== null && page < MAX_PAGES; page++) {
    const result = await client.rest(path)
    for (const repo of read(result.data)) repos.push(toAccountRepo(repo))
    const next = nextLink(result.headers.get('link'))
    // The Link header carries an absolute URL, the client wants a path.
    path = next === null ? null : toPath(next, client.baseUrl)
  }
  return repos
}

/** Every repo the token can see through its user, collaborations and organizations. */
export function listAccountRepos(client: GithubClient): Promise<AccountRepo[]> {
  return listPaged(
    client,
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    (data) => parsePayload(z.array(restRepoSchema), data, 'repository list'),
  )
}

const installationReposSchema = z.object({
  total_count: z.number().int(),
  repositories: z.array(restRepoSchema),
})

/** Every repo a GitHub App installation was granted. Needs an installation token. */
export function listInstallationRepos(client: GithubClient): Promise<AccountRepo[]> {
  return listPaged(
    client,
    '/installation/repositories?per_page=100',
    (data) =>
      parsePayload(installationReposSchema, data, 'installation repository list').repositories,
  )
}

/** How many repos the installation can read, from one small page. */
export async function countInstallationRepos(client: GithubClient): Promise<number> {
  const result = await client.rest('/installation/repositories?per_page=1')
  return parsePayload(installationReposSchema, result.data, 'installation repository list')
    .total_count
}

/** The part after the API root, so a GitHub Enterprise `/api/v3` prefix is not doubled. */
function toPath(url: string, baseUrl: string): string {
  if (url.startsWith(`${baseUrl}/`)) return url.slice(baseUrl.length)
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}
