import { z } from 'zod'
import type { GithubClient, RestResult } from './client.js'
import { GithubError } from './errors.js'
import { parsePayload } from './schemas.js'

// GitHub reads of the fix run tracker: a workflow run (with ETags), the runs of a workflow (to
// find a run by its run name), a run's artifacts and the artifact zip, and a branch head.

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/**
 * The answer to a conditional read: `modified: false` when GitHub answered 304 to the ETag that
 * was sent (nothing changed, and the request did not count against the rate limit).
 */
export type ConditionalRead<T> =
  { modified: false; etag: string | null } | { modified: true; etag: string | null; value: T }

/** GET with If-None-Match: the parsed body, or `modified: false` on a 304. */
export async function conditionalGet<T>(
  client: GithubClient,
  path: string,
  etag: string | null | undefined,
  parse: (result: RestResult) => T,
): Promise<ConditionalRead<T>> {
  const result = await client.rest(path, {
    acceptStatus: [304],
    ...(etag && { ifNoneMatch: etag }),
  })
  const next = result.headers.get('etag')
  if (result.status === 304) return { modified: false, etag: next ?? etag ?? null }
  return { modified: true, etag: next, value: parse(result) }
}

const restWorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive().optional(),
  /** The run name (`run-name`), or the commit message when the workflow sets none. */
  display_title: z.string().optional(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})

/** A workflow run as the tracker reads it. */
export interface GithubWorkflowRun {
  id: number
  attempt: number
  title: string
  /** queued, waiting, requested, pending, in_progress or completed. */
  status: string
  /** Set once completed: success, failure, cancelled, timed_out, skipped, ... */
  conclusion: string | null
  createdAt: string
  updatedAt: string | null
}

function toWorkflowRun(raw: z.infer<typeof restWorkflowRunSchema>): GithubWorkflowRun {
  return {
    id: raw.id,
    attempt: raw.run_attempt ?? 1,
    title: raw.display_title ?? '',
    status: raw.status ?? 'queued',
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? null,
  }
}

/**
 * GET /repos/{owner}/{repo}/actions/runs/{id} with the last ETag. Null when the run is gone
 * (deleted, or the repo is no longer visible).
 */
export async function fetchWorkflowRun(
  client: GithubClient,
  owner: string,
  name: string,
  runId: number,
  etag?: string | null,
): Promise<ConditionalRead<GithubWorkflowRun> | null> {
  try {
    return await conditionalGet(
      client,
      `${repoPath(owner, name)}/actions/runs/${runId}`,
      etag,
      (result) => toWorkflowRun(parsePayload(restWorkflowRunSchema, result.data, 'workflow run')),
    )
  } catch (error) {
    if (error instanceof GithubError && error.kind === 'not_found') return null
    throw error
  }
}

const workflowRunsSchema = z.object({ workflow_runs: z.array(restWorkflowRunSchema) })

/**
 * GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs for workflow_dispatch runs created
 * at or after `createdSince`, newest first, at most 100.
 */
export async function listWorkflowRuns(
  client: GithubClient,
  input: { owner: string; name: string; workflow: string; createdSince: Date },
): Promise<GithubWorkflowRun[]> {
  const params = new URLSearchParams({
    event: 'workflow_dispatch',
    created: `>=${input.createdSince.toISOString()}`,
    per_page: '100',
  })
  const path = `${repoPath(input.owner, input.name)}/actions/workflows/${encodeURIComponent(input.workflow)}/runs?${params.toString()}`
  const result = await client.rest(path)
  return parsePayload(workflowRunsSchema, result.data, 'workflow runs').workflow_runs.map(
    toWorkflowRun,
  )
}

const artifactsSchema = z.object({
  artifacts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      size_in_bytes: z.number().int().nonnegative(),
      expired: z.boolean(),
      created_at: z.string().nullable().optional(),
    }),
  ),
})

export interface GithubArtifact {
  id: number
  name: string
  sizeInBytes: number
  expired: boolean
  createdAt: string | null
}

/** GET /repos/{owner}/{repo}/actions/runs/{id}/artifacts, at most 100. */
export async function listRunArtifacts(
  client: GithubClient,
  owner: string,
  name: string,
  runId: number,
): Promise<GithubArtifact[]> {
  const result = await client.rest(
    `${repoPath(owner, name)}/actions/runs/${runId}/artifacts?per_page=100`,
  )
  return parsePayload(artifactsSchema, result.data, 'artifacts').artifacts.map((a) => ({
    id: a.id,
    name: a.name,
    sizeInBytes: a.size_in_bytes,
    expired: a.expired,
    createdAt: a.created_at ?? null,
  }))
}

export interface DownloadArtifactOptions {
  /** Fetch for the blob storage download (no credential is sent there). */
  fetch?: typeof fetch
  /** Largest zip accepted, in bytes. */
  maxBytes: number
  timeoutMs?: number
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new GithubError('parse', `The artifact is larger than ${maxBytes} bytes`)
  }
  if (!response.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new GithubError('parse', `The artifact is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Downloads an artifact zip: GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip answers 302 to
 * a short lived blob storage URL, which is fetched without the GitHub credential and read up to
 * `maxBytes`. An expired artifact (410) is a `not_found` GithubError.
 */
export async function downloadArtifact(
  client: GithubClient,
  input: { owner: string; name: string; artifactId: number },
  options: DownloadArtifactOptions,
): Promise<Uint8Array> {
  const path = `${repoPath(input.owner, input.name)}/actions/artifacts/${input.artifactId}/zip`
  const result = await client.rest(path, { redirect: 'manual', acceptStatus: [302, 410] })
  if (result.status === 410) {
    throw new GithubError('not_found', `Artifact ${input.artifactId} has expired`, { status: 410 })
  }
  const location = result.headers.get('location')
  if (!location) throw new GithubError('parse', 'GitHub sent no download location for the artifact')
  const fetchImpl = options.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  try {
    let response: Response
    try {
      response = await fetchImpl(location, { signal: controller.signal })
    } catch (error) {
      throw new GithubError('network', 'The artifact download failed', { cause: error })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new GithubError('http', `The artifact download answered ${response.status}`, {
        status: response.status,
      })
    }
    return await readCapped(response, options.maxBytes)
  } catch (error) {
    if (error instanceof GithubError) throw error
    throw new GithubError('network', 'Reading the artifact failed', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

const branchSchema = z.object({ commit: z.object({ sha: z.string() }) })

/** The head commit of a branch (GET /repos/{owner}/{repo}/branches/{branch}), null when missing. */
export async function fetchBranchHead(
  client: GithubClient,
  owner: string,
  name: string,
  branch: string,
): Promise<string | null> {
  const result = await client.rest(
    `${repoPath(owner, name)}/branches/${encodeURIComponent(branch)}`,
    { acceptStatus: [404] },
  )
  if (result.status === 404) return null
  return parsePayload(branchSchema, result.data, 'branch').commit.sha
}
