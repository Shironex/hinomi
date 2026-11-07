import {
  addRepoOverrideRequestSchema,
  deploymentDeploysQuerySchema,
  deploymentDeploysResponseSchema,
  deploymentDetailSchema,
  deploymentsResponseSchema,
  fixPlanQuerySchema,
  fixPlanSchema,
  fixPlansResponseSchema,
  idParamSchema,
  repoOverrideParamsSchema,
  repoOverridesResponseSchema,
  reposResponseSchema,
  type BlindSpotType,
  type DeploymentItem,
  type GuardCheck,
  type RepoOverride,
  type SeverityCounts,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { Repositories, Source } from '../../repository/index.js'
import {
  isExposed,
  isImageOnly,
  listRankedFindings,
  loadOverrideIndex,
  needsRepoMapping,
  type RankedFinding,
} from '../../scan/index.js'
import { readDeployHistory } from '../deploy-history.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, readQuery, send } from '../http.js'
import { deploymentGuards } from './guards.js'
import {
  toDeploymentRef,
  toFindingListItem,
  toFixPlan,
  toFixPlanRef,
  toRepoRef,
} from '../serialize.js'

function alertsCoverage(repos: RepoRow[]): DeploymentItem['coverage']['alerts'] {
  if (repos.length === 0) return 'none'
  if (repos.some((r) => r.alertsEnabled === false)) return 'disabled'
  if (repos.some((r) => r.alertsEnabled === null)) return 'unknown'
  return 'enabled'
}

/** Findings that are not fixed and reach the deployment. */
function openFindingsOf(ranked: RankedFinding[], deploymentId: number): RankedFinding[] {
  return ranked.filter(
    (r) => r.state !== 'fixed' && r.deployments.some((d) => d.id === deploymentId),
  )
}

function bySeverity(findings: RankedFinding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const f of findings) if (f.kind === 'advisory') counts[f.factors.severity]++
  return counts
}

interface JoinContext {
  repositories: Repositories
  ranked: RankedFinding[]
  sources: Map<number, Source>
}

function joinContext(repositories: Repositories): JoinContext {
  return {
    repositories,
    ranked: listRankedFindings(repositories),
    sources: new Map(repositories.sources.list().map((s) => [s.id, s])),
  }
}

function toItem(ctx: JoinContext, deployment: DeploymentRow): DeploymentItem {
  const { repositories } = ctx
  const overrides = repositories.deployments.listRepoOverrides(deployment.id)
  const repos = repositories.deployments
    .effectiveRepoIds(deployment.id)
    .map((id) => repositories.repos.get(id))
    .filter((r): r is RepoRow => r !== undefined)
  const open = openFindingsOf(ctx.ranked, deployment.id)
  const blindSpots = [
    ...new Set(
      open
        .filter((f) => f.kind === 'blind_spot' && f.finding.blindSpotType !== null)
        .map((f) => f.finding.blindSpotType as BlindSpotType),
    ),
  ]
  const source = ctx.sources.get(deployment.sourceId)
  const mapped = repos.length > 0 || !needsRepoMapping(deployment)
  const imageOnly = repos.length === 0 && isImageOnly(deployment)
  return {
    ...toDeploymentRef(deployment),
    source: {
      id: deployment.sourceId,
      kind: source?.kind ?? 'coolify',
      name: source?.name ?? 'unknown',
    },
    externalId: deployment.externalId,
    status: deployment.status,
    image: deployment.image,
    gitRepository: deployment.gitRepository,
    gitBranch: deployment.gitBranch,
    lastDeployedAt: deployment.lastDeployedAt?.toISOString() ?? null,
    firstSeenAt: deployment.firstSeenAt.toISOString(),
    lastSeenAt: deployment.lastSeenAt.toISOString(),
    mapping: overrides.length > 0 ? 'override' : repos.length > 0 ? 'auto' : 'none',
    repos: repos.map(toRepoRef),
    coverage: {
      alerts: alertsCoverage(repos),
      blindSpots,
      covered: mapped && !imageOnly && blindSpots.length === 0,
      imageOnly,
    },
    openFindings: bySeverity(open),
    exposed: open.filter(isExposed).length,
    openBlindSpots: open.filter((f) => f.kind === 'blind_spot').length,
  }
}

function overridesOf(repositories: Repositories, deploymentId: number): RepoOverride[] {
  return repositories.deployments.listRepoOverrides(deploymentId).flatMap((o) => {
    const repo = repositories.repos.get(o.repoId)
    return repo
      ? [{ repo: toRepoRef(repo), note: o.note, createdAt: o.createdAt.toISOString() }]
      : []
  })
}

function requireDeployment(repositories: Repositories, id: number): DeploymentRow {
  const deployment = repositories.deployments.get(id)
  if (!deployment) throw notFound('Deployment')
  return deployment
}

export function deploymentsRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  app.get('/', (c) => {
    const ctx = joinContext(repositories)
    const items = repositories.deployments.list().map((d) => toItem(ctx, d))
    return send(c, deploymentsResponseSchema, { items })
  })

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    const deployment = requireDeployment(repositories, id)
    const ctx = joinContext(repositories)
    const registered = new Set<GuardCheck>(deps.guards.map((g) => g.check))
    return send(c, deploymentDetailSchema, {
      ...toItem(ctx, deployment),
      watchPaths: deployment.watchPaths,
      overrides: overridesOf(repositories, id),
      findings: openFindingsOf(ctx.ranked, id).map(toFindingListItem),
      guards: deploymentGuards(
        ctx.ranked,
        deployment,
        repositories.deployments.effectiveRepoIds(id),
        loadOverrideIndex(repositories),
        registered,
      ),
    })
  })

  /** Recent deploys and their commits, read live from the deployment's source. */
  app.get('/:id/deploys', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const deployment = requireDeployment(repositories, id)
    const { limit } = readQuery(c, deploymentDeploysQuerySchema)
    const history = await readDeployHistory(repositories, deployment, limit, {
      ...(deps.sourceFetch && { fetch: deps.sourceFetch }),
    })
    return send(c, deploymentDeploysResponseSchema, history)
  })

  app.get('/:id/overrides', (c) => {
    const { id } = readParams(c, idParamSchema)
    requireDeployment(repositories, id)
    return send(c, repoOverridesResponseSchema, { items: overridesOf(repositories, id) })
  })

  /** Maps the deployment to a repo by hand. The repo row is created when it is new. */
  app.post('/:id/overrides', async (c) => {
    const { id } = readParams(c, idParamSchema)
    requireDeployment(repositories, id)
    const body = await readJson(c, addRepoOverrideRequestSchema)
    const [owner = '', name = ''] = body.repo.split('/')
    repositories.db.transaction(() => {
      const repo = repositories.repos.upsert({ owner, name })
      repositories.deployments.addRepoOverride(id, repo.id, body.note ?? undefined)
    })
    return send(c, repoOverridesResponseSchema, { items: overridesOf(repositories, id) }, 201)
  })

  app.delete('/:id/overrides/:repoId', (c) => {
    const { id, repoId } = readParams(c, repoOverrideParamsSchema)
    requireDeployment(repositories, id)
    if (!repositories.deployments.removeRepoOverride(id, repoId)) {
      throw new HttpError(404, 'not_found', 'Override not found')
    }
    return send(c, repoOverridesResponseSchema, { items: overridesOf(repositories, id) })
  })

  return app
}

export function reposRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps
  app.get('/', (c) =>
    send(c, reposResponseSchema, { items: repositories.repos.list().map(toRepoRef) }),
  )

  app.get('/:id/plan', (c) => {
    const { id } = readParams(c, idParamSchema)
    const { scan } = readQuery(c, fixPlanQuerySchema)
    const repo = repositories.repos.get(id)
    if (!repo) throw notFound('Repo')
    const row = repositories.fixPlans.forRepo(id, scan)
    if (!row) throw notFound('Fix plan')
    return send(c, fixPlanSchema, toFixPlan(row, toRepoRef(repo)))
  })

  return app
}

/** GET /api/plans: the latest plan summary of every repo, most findings cleared first. */
export function plansRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps
  app.get('/', (c) => {
    const items = repositories.fixPlans.latestPerRepo().flatMap((row) => {
      const repo = repositories.repos.get(row.repoId)
      return repo ? [{ ...toFixPlanRef(row), repo: toRepoRef(repo) }] : []
    })
    items.sort(
      (a, b) =>
        b.summary.findings.cleared - a.summary.findings.cleared ||
        a.repo.fullName.localeCompare(b.repo.fullName),
    )
    return send(c, fixPlansResponseSchema, { items })
  })
  return app
}
