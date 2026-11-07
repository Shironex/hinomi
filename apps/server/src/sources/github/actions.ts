import { z } from 'zod'
import type { GithubClient } from './client.js'
import { GithubError } from './errors.js'
import { parsePayload, restRepoSchema } from './schemas.js'

// GitHub calls of the fix runner: the repo facts a dispatch needs, the workflow_dispatch call,
// reading the caller workflow file, and cheap reads that probe what a token may do.

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** A repo relative path with each segment encoded, slashes kept. */
function filePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export interface RunnerRepoMeta {
  /** As GitHub spells them, which `github.repository` in the workflow matches. */
  owner: string
  name: string
  fullName: string
  defaultBranch: string
  /** Internal repos (GitHub Enterprise) count as private: their code is not public. */
  visibility: 'public' | 'private'
}

/** The repo's spelling, default branch and visibility. */
export async function fetchRunnerRepoMeta(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<RunnerRepoMeta> {
  const result = await client.rest(repoPath(owner, name))
  const repo = parsePayload(restRepoSchema, result.data, 'repository')
  if (!repo.default_branch) {
    throw new GithubError('parse', `GitHub reports no default branch for ${owner}/${name}`)
  }
  const isPublic = repo.visibility === 'public' || (!repo.visibility && repo.private === false)
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: `${repo.owner.login}/${repo.name}`,
    defaultBranch: repo.default_branch,
    visibility: isPublic ? 'public' : 'private',
  }
}

export interface WorkflowDispatchInput {
  owner: string
  name: string
  /** The workflow file name under .github/workflows, or its id. */
  workflow: string
  ref: string
  inputs: Record<string, string>
}

export interface WorkflowDispatchResult {
  /** Null when GitHub answered without run details (an older GitHub Enterprise Server). */
  workflowRunId: number | null
  htmlUrl: string | null
}

const dispatchDetailsSchema = z.object({
  workflow_run_id: z.number().int().positive(),
  html_url: z.string().optional(),
})

/**
 * POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches with
 * `return_run_details`, so GitHub answers 200 with the run id. Throws a GithubError for any
 * refusal (404 no such workflow on the ref, 403 no permission, 422 bad inputs); a write is
 * never retried after a 5xx or a network error.
 */
export async function dispatchWorkflow(
  client: GithubClient,
  input: WorkflowDispatchInput,
): Promise<WorkflowDispatchResult> {
  const path = `${repoPath(input.owner, input.name)}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`
  const result = await client.rest(path, {
    method: 'POST',
    body: { ref: input.ref, inputs: input.inputs, return_run_details: true },
  })
  if (result.status === 204 || result.data === null) return { workflowRunId: null, htmlUrl: null }
  const details = dispatchDetailsSchema.safeParse(result.data)
  if (!details.success) return { workflowRunId: null, htmlUrl: null }
  return { workflowRunId: details.data.workflow_run_id, htmlUrl: details.data.html_url ?? null }
}

const contentFileSchema = z.object({
  type: z.literal('file'),
  encoding: z.string(),
  content: z.string(),
})

/** Largest workflow file read; a caller workflow is a few dozen lines. */
const MAX_FILE_BYTES = 256 * 1024

/**
 * A text file from the repo at `ref`, or null when it does not exist. Throws a GithubError
 * (kind `permission`) when the credential may not read contents.
 */
export async function readRepoFile(
  client: GithubClient,
  owner: string,
  name: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const url = `${repoPath(owner, name)}/contents/${filePath(path)}?ref=${encodeURIComponent(ref)}`
  const result = await client.rest(url, { acceptStatus: [404] })
  if (result.status === 404) return null
  const file = parsePayload(contentFileSchema, result.data, 'repository file')
  if (file.encoding !== 'base64') {
    throw new GithubError('parse', `GitHub sent ${path} as ${file.encoding}, not base64`)
  }
  const bytes = Buffer.from(file.content, 'base64')
  if (bytes.length > MAX_FILE_BYTES) {
    throw new GithubError('parse', `${path} is larger than ${MAX_FILE_BYTES} bytes`)
  }
  return bytes.toString('utf8')
}

/** What a harmless read answered: `ok`, `denied` (403) or `missing` (404). */
export type ProbeOutcome = 'ok' | 'denied' | 'missing'

async function probe(client: GithubClient, path: string): Promise<ProbeOutcome> {
  // 409 is an empty repo: the read was allowed, there is just nothing to list.
  const result = await client.rest(path, { acceptStatus: [403, 404, 409] })
  if (result.status === 403) return 'denied'
  if (result.status === 404) return 'missing'
  return 'ok'
}

/** Reads the workflow's metadata: needs Actions (read) on a fine grained token. */
export function probeWorkflowRead(
  client: GithubClient,
  owner: string,
  name: string,
  workflow: string,
): Promise<ProbeOutcome> {
  return probe(client, `${repoPath(owner, name)}/actions/workflows/${encodeURIComponent(workflow)}`)
}

/** Lists one pull request: needs Pull requests (read). */
export function probePullsRead(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<ProbeOutcome> {
  return probe(client, `${repoPath(owner, name)}/pulls?state=all&per_page=1`)
}

/** Lists one commit: needs Contents (read). */
export function probeContentsRead(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<ProbeOutcome> {
  return probe(client, `${repoPath(owner, name)}/commits?per_page=1`)
}
