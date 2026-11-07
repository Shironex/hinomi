import { z } from 'zod'
import { filePath, repoPath } from './actions.js'
import type { GithubClient } from './client.js'
import { GithubError } from './errors.js'
import { parsePayload } from './schemas.js'

// GitHub writes of the setup PR: a branch from a commit and one file put on it. Writes go
// through `client.rest` with a method and are never retried after a 5xx or a network error.

const fileSchema = z.object({
  type: z.literal('file'),
  sha: z.string(),
  encoding: z.string(),
  content: z.string(),
})

/** A file on a ref with its blob SHA (needed to replace it), or null when it does not exist. */
export async function readRepoFileWithSha(
  client: GithubClient,
  owner: string,
  name: string,
  path: string,
  ref: string,
): Promise<{ text: string; sha: string } | null> {
  const url = `${repoPath(owner, name)}/contents/${filePath(path)}?ref=${encodeURIComponent(ref)}`
  const result = await client.rest(url, { acceptStatus: [404] })
  if (result.status === 404) return null
  const file = parsePayload(fileSchema, result.data, 'repository file')
  if (file.encoding !== 'base64') {
    throw new GithubError('parse', `GitHub sent ${path} as ${file.encoding}, not base64`)
  }
  return { text: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha }
}

/**
 * POST /repos/{owner}/{repo}/git/refs: creates `branch` at `sha`. False when the branch already
 * exists (422), so two clicks at once end up on the same branch.
 */
export async function createBranch(
  client: GithubClient,
  owner: string,
  name: string,
  branch: string,
  sha: string,
): Promise<boolean> {
  const result = await client.rest(`${repoPath(owner, name)}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha },
    acceptStatus: [422],
  })
  return result.status !== 422
}

export interface PutFileInput {
  owner: string
  name: string
  path: string
  branch: string
  text: string
  message: string
  /** The blob SHA of the file being replaced; omitted when creating it. */
  sha?: string
}

/** PUT /repos/{owner}/{repo}/contents/{path}: creates or replaces a file with one commit. */
export async function putRepoFile(client: GithubClient, input: PutFileInput): Promise<void> {
  await client.rest(`${repoPath(input.owner, input.name)}/contents/${filePath(input.path)}`, {
    method: 'PUT',
    body: {
      message: input.message,
      content: Buffer.from(input.text, 'utf8').toString('base64'),
      branch: input.branch,
      ...(input.sha && { sha: input.sha }),
    },
  })
}
