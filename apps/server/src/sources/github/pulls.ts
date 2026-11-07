import { z } from 'zod'
import type { GithubClient } from './client.js'
import { GithubError } from './errors.js'
import { conditionalGet, type ConditionalRead } from './runs.js'
import { parsePayload } from './schemas.js'

// GitHub calls that open and update the fix pull request (mode A of the runner design): list the
// PRs of a branch, create one, change its title and body, flip its draft state, and add labels
// that already exist. Writes go through `client.rest` with a method and are never retried after
// a 5xx or a network error.

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

const validationSchema = z.object({
  message: z.string().optional(),
  errors: z
    .array(z.object({ message: z.string().optional(), code: z.string().optional() }))
    .optional(),
})

/**
 * A pull request write that GitHub answered 422. The client keeps only GitHub's top message
 * ("Validation Failed"), so the reasons in `errors` are read here to tell a missing branch from
 * an empty diff or a PR that already exists.
 */
function validationError(data: unknown): GithubError {
  const parsed = validationSchema.safeParse(data)
  const reasons = parsed.success
    ? (parsed.data.errors ?? []).map((e) => e.message ?? e.code ?? '').filter((m) => m !== '')
    : []
  const top = parsed.success ? (parsed.data.message ?? '') : ''
  const detail = [top, ...reasons].filter((m) => m !== '').join(': ')
  return new GithubError('http', `GitHub answered 422${detail ? `: ${detail}` : ''}`, {
    status: 422,
  })
}

const restPullSchema = z.object({
  number: z.number().int().positive(),
  /** GraphQL id, needed to change the draft state. */
  node_id: z.string(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  title: z.string(),
  body: z.string().nullable(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
})

/** A pull request as the fix PR publisher reads it. */
export interface GithubPull {
  number: number
  nodeId: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  title: string
  body: string
  merged: boolean
  /** The commit the merge made on the base branch, once merged. */
  mergeSha: string | null
  closedAt: string | null
  labels: string[]
  headRef: string
  headSha: string
  baseRef: string
}

function toPull(raw: z.infer<typeof restPullSchema>): GithubPull {
  return {
    number: raw.number,
    nodeId: raw.node_id,
    url: raw.html_url,
    state: raw.state,
    draft: raw.draft ?? false,
    title: raw.title,
    body: raw.body ?? '',
    merged: Boolean(raw.merged_at),
    mergeSha: raw.merged_at ? (raw.merge_commit_sha ?? null) : null,
    closedAt: raw.closed_at ?? null,
    labels: (raw.labels ?? []).map((label) => label.name),
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
  }
}

export interface BranchPullsQuery {
  owner: string
  name: string
  /** The branch in the same repo, without the owner. */
  branch: string
  base: string
  state: 'open' | 'closed'
}

/**
 * GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base=...: the branch's PRs from the
 * repo itself (never from a fork), most recently updated first, at most 30.
 */
export async function listBranchPulls(
  client: GithubClient,
  query: BranchPullsQuery,
): Promise<GithubPull[]> {
  const params = new URLSearchParams({
    state: query.state,
    head: `${query.owner}:${query.branch}`,
    base: query.base,
    sort: 'updated',
    direction: 'desc',
    per_page: '30',
  })
  const result = await client.rest(
    `${repoPath(query.owner, query.name)}/pulls?${params.toString()}`,
  )
  return parsePayload(z.array(restPullSchema), result.data, 'pull requests').map(toPull)
}

/**
 * GET /repos/{owner}/{repo}/pulls/{number} with the last ETag. Null when the PR is gone (the
 * repo was deleted or is no longer visible).
 */
export async function fetchPull(
  client: GithubClient,
  input: { owner: string; name: string; number: number },
  etag?: string | null,
): Promise<ConditionalRead<GithubPull> | null> {
  try {
    return await conditionalGet(
      client,
      `${repoPath(input.owner, input.name)}/pulls/${input.number}`,
      etag,
      (result) => toPull(parsePayload(restPullSchema, result.data, 'pull request')),
    )
  } catch (error) {
    if (error instanceof GithubError && error.kind === 'not_found') return null
    throw error
  }
}

export interface CreatePullInput {
  owner: string
  name: string
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

/** POST /repos/{owner}/{repo}/pulls. Needs Pull requests: write. */
export async function createPull(
  client: GithubClient,
  input: CreatePullInput,
): Promise<GithubPull> {
  const result = await client.rest(`${repoPath(input.owner, input.name)}/pulls`, {
    method: 'POST',
    body: {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft,
      maintainer_can_modify: false,
    },
    acceptStatus: [422],
  })
  if (result.status === 422) throw validationError(result.data)
  return toPull(parsePayload(restPullSchema, result.data, 'pull request'))
}

/** PATCH /repos/{owner}/{repo}/pulls/{number} with a new title and body. */
export async function updatePull(
  client: GithubClient,
  input: { owner: string; name: string; number: number; title: string; body: string },
): Promise<GithubPull> {
  const result = await client.rest(`${repoPath(input.owner, input.name)}/pulls/${input.number}`, {
    method: 'PATCH',
    body: { title: input.title, body: input.body },
    acceptStatus: [422],
  })
  if (result.status === 422) throw validationError(result.data)
  return toPull(parsePayload(restPullSchema, result.data, 'pull request'))
}

const READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`
const TO_DRAFT = `mutation($id: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`

/**
 * Turns a PR into a draft or marks it ready for review. The REST API has no way to change the
 * draft state of an existing PR, so this is the GraphQL `convertPullRequestToDraft` or
 * `markPullRequestReadyForReview` mutation. Both set an absolute state, so the client's retry of
 * a GraphQL request after a 5xx cannot do anything twice.
 */
export async function setPullDraft(
  client: GithubClient,
  nodeId: string,
  draft: boolean,
): Promise<void> {
  await client.graphql(draft ? TO_DRAFT : READY, { id: nodeId })
}

/**
 * Of `names`, the labels that exist in the repo (GET /repos/{owner}/{repo}/labels/{name}, a 404
 * means it does not). One request per name, so a repo with many labels needs no paging.
 */
export async function existingLabels(
  client: GithubClient,
  owner: string,
  name: string,
  names: readonly string[],
): Promise<string[]> {
  const found: string[] = []
  for (const label of names) {
    const path = `${repoPath(owner, name)}/labels/${encodeURIComponent(label)}`
    const result = await client.rest(path, { acceptStatus: [404] })
    if (result.status !== 404) found.push(label)
  }
  return found
}

/**
 * POST /repos/{owner}/{repo}/issues/{number}/labels: adds labels to a PR, keeping its others.
 * Only send labels that exist; GitHub would create the missing ones.
 */
export async function addPullLabels(
  client: GithubClient,
  input: { owner: string; name: string; number: number; labels: string[] },
): Promise<void> {
  await client.rest(`${repoPath(input.owner, input.name)}/issues/${input.number}/labels`, {
    method: 'POST',
    body: { labels: input.labels },
  })
}
