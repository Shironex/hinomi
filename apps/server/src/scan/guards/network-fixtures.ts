import { guardEvidenceSchema, type DeploymentFacts } from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { RepoScan } from '../collect.js'
import { noRepoFiles } from './testing.js'
import type { GuardContext, GuardSubjectResult } from './types.js'

// Test fixtures for the facts based checks. Fictional data only.

const AT = new Date('2026-11-08T10:00:00Z')

export function facts(over: Partial<DeploymentFacts> = {}): DeploymentFacts {
  return {
    version: 1,
    fetchedAt: AT.toISOString(),
    buildPack: 'dockerfile',
    image: null,
    commit: null,
    user: null,
    services: [],
    dockerfile: null,
    mounts: [],
    mountsChecked: [],
    networks: [],
    hostNetwork: false,
    privileged: false,
    destination: { server: 'edge-1', typeName: 'App\\Models\\StandaloneDocker', id: 3 },
    attachedToDestination: true,
    project: { key: 'proj-shop', name: 'kestrel-shop', environment: 'production' },
    autoDeploy: true,
    gaps: {},
    ...over,
  }
}

export function deployment(
  id: number,
  name: string,
  over: Partial<DeploymentRow> = {},
): DeploymentRow {
  return {
    id,
    sourceId: 1,
    externalId: `uuid-${id}`,
    kind: 'application',
    name,
    domains: [],
    reach: 'internal',
    server: 'edge-1',
    status: 'running:healthy',
    image: null,
    gitRepository: null,
    gitBranch: null,
    watchPaths: null,
    repoId: null,
    lastDeployedAt: null,
    facts: facts(),
    factsVersion: null,
    factsUpdatedAt: null,
    imageScannedAt: null,
    firstSeenAt: AT,
    lastSeenAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }
}

export function repo(id: number, name: string): RepoRow {
  return {
    id,
    owner: 'kestrel-co',
    name,
    defaultBranch: 'main',
    archived: false,
    alertsEnabled: true,
    lastScannedAt: null,
    runnerEnabled: false,
    runnerWorkflow: null,
    runnerMajorsAgent: 'off',
    runnerKind: 'github_actions',
    sourceId: null,
    sourceOverrideId: null,
    releaseTier: 'auto',
    latestReleaseTag: null,
    latestReleaseAt: null,
    releaseInstallers: null,
    releaseCheckedAt: null,
    createdAt: AT,
    updatedAt: AT,
  }
}

/** A context over these rows. `lockfiles` maps repo id to the lockfiles OSV read, or null for a failed read. */
export function context(
  deployments: DeploymentRow[],
  repos: RepoRow[] = [],
  lockfiles: Record<number, string[] | null> = {},
): GuardContext {
  const byRepo = new Map<number, DeploymentRow[]>()
  for (const d of deployments) {
    if (d.repoId === null) continue
    byRepo.set(d.repoId, [...(byRepo.get(d.repoId) ?? []), d])
  }
  const scans = new Map<number, RepoScan>()
  for (const r of repos) {
    const files = lockfiles[r.id]
    scans.set(r.id, {
      repo: r,
      deployed: true,
      health: { status: 'error', error: 'not read' },
      alerts: { status: 'error', error: 'not read' },
      osv:
        files === undefined || files === null
          ? { status: 'error', error: 'not read' }
          : { status: 'ok', value: { matches: [], lockfiles: files, unparseable: [] } },
    })
  }
  return {
    deployments,
    repos,
    index: { deployments, byRepo, unmapped: deployments.filter((d) => d.repoId === null) },
    scans,
    repoFiles: noRepoFiles(),
    now: AT,
    support: null,
    supportWindowDays: 90,
    behindReleases: { rust: 4, bun: 4 },
  }
}

/** The result for a deployment; fails the test when the check left it out. Evidence must validate. */
export function resultFor(results: readonly GuardSubjectResult[], deploymentId: number) {
  const found = results.find(
    (r) => 'deploymentId' in r.subject && r.subject.deploymentId === deploymentId,
  )
  if (!found) throw new Error(`no result for deployment ${deploymentId}`)
  if (found.level !== null && found.evidence) guardEvidenceSchema.parse(found.evidence)
  return found
}

/** The `reason` of a result's evidence, null when it has none. */
export function reasonOf(result: GuardSubjectResult): string | null {
  return result.level !== null && result.evidence && 'reason' in result.evidence
    ? (result.evidence.reason ?? null)
    : null
}
