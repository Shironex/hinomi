import { deploymentRecordSchema, type DeploymentRecord } from '@hinomi/shared'
import { z } from 'zod'
import { hasPublicDomain, normalizeRepo, toIso } from '../coolify/normalize.js'
import { mapLimit } from '../osv/index.js'
import { createDokployClient, type DokployClient, type DokployClientOptions } from './client.js'
import { DokployError } from './errors.js'

// The Dokploy inventory (docs/design/phase-2.md section 9.4): `project.all` only to list the
// ids of applications and compose services, then `application.one` and `compose.one` for each,
// so the record comes from per resource routes. Databases are not read: their records are
// where Dokploy keeps passwords, and they carry no repo to join. Only the join fields are
// read (repo, branch, image, domains, server, status, last deploy); no container fact is
// claimed until it is confirmed against a live instance, so every container check says unknown.

export type DokployOptions = Pick<
  DokployClientOptions,
  'baseUrl' | 'token' | 'timeoutMs' | 'fetch'
> & {
  /** Configured name of the source, set as `source` on every record. */
  name: string
  /** Resources read in parallel. Defaults to 4. */
  concurrency?: number
}

const DEFAULT_CONCURRENCY = 4

type ResourceKind = 'application' | 'compose'

interface ResourceRef {
  kind: ResourceKind
  id: string
}

/** Optional text: anything else (or blank) reads as null rather than failing the resource. */
const text = z
  .string()
  .transform((s) => s.trim() || null)
  .nullish()
  .catch(null)
  .transform((s) => s ?? null)

/** The ids under `key` of a list of services; entries without one are left out. */
const idList = (key: 'applicationId' | 'composeId') =>
  z
    .array(z.unknown())
    .nullish()
    .catch(null)
    .transform((list) =>
      (list ?? []).flatMap((item) => {
        const id =
          typeof item === 'object' && item !== null ? (item as Record<string, unknown>)[key] : null
        return typeof id === 'string' && id.trim() ? [id.trim()] : []
      }),
    )

const servicesSchema = z.object({
  applications: idList('applicationId'),
  compose: idList('composeId'),
})

/** `project.all`: projects with environments (v0.23 and later) or the services directly (older). */
const projectSchema = servicesSchema.extend({
  environments: z
    .array(servicesSchema.catch({ applications: [], compose: [] }))
    .nullish()
    .catch(null),
})

const domainSchema = z.object({
  host: text,
  https: z.boolean().nullish().catch(null),
  path: text,
})

const deploySchema = z.object({ status: text, createdAt: text })

/** The fields of `application.one` and `compose.one` that the record is built from. */
const resourceSchema = z.object({
  name: text,
  sourceType: text,
  applicationStatus: text,
  composeStatus: text,
  // GitHub
  owner: text,
  repository: text,
  branch: text,
  // GitLab
  gitlabOwner: text,
  gitlabRepository: text,
  gitlabBranch: text,
  gitlabPathNamespace: text,
  // Gitea
  giteaOwner: text,
  giteaRepository: text,
  giteaBranch: text,
  // Bitbucket
  bitbucketOwner: text,
  bitbucketRepository: text,
  bitbucketRepositorySlug: text,
  bitbucketBranch: text,
  // Any git URL
  customGitUrl: text,
  customGitBranch: text,
  // A registry image (applications with source type docker)
  dockerImage: text,
  server: z.object({ name: text }).nullish().catch(null),
  domains: z.array(domainSchema.nullable().catch(null)).nullish().catch(null),
  deployments: z.array(deploySchema.nullable().catch(null)).nullish().catch(null),
})
type Resource = z.infer<typeof resourceSchema>

/** A git URL without any user or password in it (a custom git URL may carry a token). */
export function withoutCredentials(raw: string): string {
  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return raw
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    // scp style (git@host:owner/name.git) has a user name but no secret.
    return raw.replace(/^[^@/\s]+:[^@/\s]+@/, '')
  }
}

interface GitSource {
  repo: string | null
  branch: string | null
  gitRepository: string | null
}

const join = (owner: string | null, name: string | null): string | null =>
  owner && name ? `${owner}/${name}` : null

/** The repo path and branch a git provider reports, null for images, uploads and raw compose. */
function providerPath(r: Resource): { path: string | null; branch: string | null } | null {
  switch (r.sourceType) {
    case 'github':
      return { path: join(r.owner, r.repository), branch: r.branch }
    case 'gitlab':
      return {
        path: r.gitlabPathNamespace ?? join(r.gitlabOwner, r.gitlabRepository),
        branch: r.gitlabBranch,
      }
    case 'gitea':
      return { path: join(r.giteaOwner, r.giteaRepository), branch: r.giteaBranch }
    case 'bitbucket':
      return {
        path: join(r.bitbucketOwner, r.bitbucketRepositorySlug ?? r.bitbucketRepository),
        branch: r.bitbucketBranch,
      }
    default:
      return null
  }
}

/** Repo and branch by the resource's source type; null for images, uploads and raw compose. */
export function gitSourceOf(r: Resource): GitSource {
  if (r.sourceType === 'git') {
    const url = r.customGitUrl ? withoutCredentials(r.customGitUrl) : null
    return { repo: normalizeRepo(url), branch: r.customGitBranch, gitRepository: url }
  }
  const provider = providerPath(r)
  if (!provider) return { repo: null, branch: null, gitRepository: null }
  const { path, branch } = provider
  if (!path) return { repo: null, branch, gitRepository: null }
  // A nested GitLab group (`group/sub/name`) is not an `owner/name` repo.
  return { repo: path.split('/').length === 2 ? path : null, branch, gitRepository: path }
}

/** Domains as URLs, `https://host/path` when Dokploy serves them over HTTPS. */
export function domainsOf(r: Resource): string[] {
  const out = new Set<string>()
  for (const d of r.domains ?? []) {
    if (!d?.host) continue
    const path = d.path && d.path !== '/' ? `/${d.path.replace(/^\/+/, '')}` : ''
    out.add(`${d.https ? 'https' : 'http'}://${d.host}${path}`.replace(/\/+$/, ''))
  }
  return [...out]
}

/** The newest successful deploy, null when the route does not list deploys. */
function lastDeployOf(r: Resource): string | null {
  let latest: string | null = null
  for (const d of r.deployments ?? []) {
    if (!d || d.status !== 'done') continue
    const at = toIso(d.createdAt)
    if (at && (!latest || at > latest)) latest = at
  }
  return latest
}

export function toRecord(source: string, ref: ResourceRef, raw: unknown): DeploymentRecord | null {
  const parsed = resourceSchema.safeParse(raw)
  if (!parsed.success) return null
  const r = parsed.data
  const domains = domainsOf(r)
  const git = gitSourceOf(r)
  const record: DeploymentRecord = {
    source,
    externalId: ref.id,
    name: r.name ?? ref.id,
    kind: ref.kind === 'application' ? 'application' : 'service',
    ...git,
    domains,
    isPublic: hasPublicDomain(domains),
    server: r.server?.name ?? null,
    // The state of the last deploy, not whether the container runs (the capabilities say so).
    status: (ref.kind === 'application' ? r.applicationStatus : r.composeStatus) ?? 'unknown',
    image: ref.kind === 'application' && r.sourceType === 'docker' ? r.dockerImage : null,
    lastDeployAt: lastDeployOf(r),
    // Dokploy has watch paths, but the field is not confirmed against a live instance yet.
    watchPaths: null,
  }
  return deploymentRecordSchema.parse(record)
}

/** The ids of every application and compose service, from `project.all`. */
export async function listResources(client: DokployClient): Promise<ResourceRef[]> {
  const body = await client.get('project.all')
  if (!Array.isArray(body)) {
    throw new DokployError(
      'invalid_response',
      'Dokploy returned an unexpected shape for project.all',
    )
  }
  const seen = new Set<string>()
  const refs: ResourceRef[] = []
  const add = (kind: ResourceKind, ids: readonly string[]) => {
    for (const id of ids) {
      if (seen.has(`${kind}:${id}`)) continue
      seen.add(`${kind}:${id}`)
      refs.push({ kind, id })
    }
  }
  for (const item of body) {
    const project = projectSchema.safeParse(item)
    if (!project.success) continue
    add('application', project.data.applications)
    add('compose', project.data.compose)
    for (const env of project.data.environments ?? []) {
      add('application', env.applications)
      add('compose', env.compose)
    }
  }
  return refs
}

async function readResource(client: DokployClient, ref: ResourceRef): Promise<unknown> {
  try {
    return ref.kind === 'application'
      ? await client.get('application.one', { applicationId: ref.id })
      : await client.get('compose.one', { composeId: ref.id })
  } catch (error) {
    // Removed between the list and this read: it is simply gone.
    if (error instanceof DokployError && error.code === 'not_found') return null
    throw error
  }
}

/**
 * Applications and compose services of one Dokploy instance, normalised. A resource whose
 * answer cannot be read as one is skipped; a transport or auth failure throws DokployError.
 */
export async function fetchDokployInventory(options: DokployOptions): Promise<DeploymentRecord[]> {
  const client = createDokployClient(options)
  const refs = await listResources(client)
  const records = await mapLimit(refs, options.concurrency ?? DEFAULT_CONCURRENCY, async (ref) => {
    const raw = await readResource(client, ref)
    return raw === null ? null : toRecord(options.name, ref, raw)
  })
  return records.filter((r): r is DeploymentRecord => r !== null)
}

export type DokployConnectionTestResult =
  | { ok: true; version: string | null; projects: number }
  | { ok: false; code: string; message: string }

/** Lists the projects (needs a valid key) and asks for the version, which may be refused. */
export async function testDokployConnection(
  options: Omit<DokployOptions, 'name' | 'concurrency'>,
): Promise<DokployConnectionTestResult> {
  try {
    const client = createDokployClient(options)
    const projects = await client.get('project.all')
    if (!Array.isArray(projects)) {
      throw new DokployError(
        'invalid_response',
        'Dokploy returned an unexpected shape for project.all',
      )
    }
    let version: string | null = null
    try {
      const answer = await client.get('settings.getDokployVersion')
      version = typeof answer === 'string' && answer.trim() ? answer.trim() : null
    } catch (error) {
      if (!(error instanceof DokployError) || error.code === 'unauthorized') throw error
    }
    return { ok: true, version, projects: projects.length }
  } catch (error) {
    if (error instanceof DokployError)
      return { ok: false, code: error.code, message: error.message }
    return { ok: false, code: 'network', message: 'Unexpected error while testing the connection' }
  }
}
