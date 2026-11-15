import {
  completeManualEntry,
  createManualDeploymentRequestSchema,
  deploymentItemSchema,
  idParamSchema,
  importManualDeploymentsRequestSchema,
  importManualDeploymentsResponseSchema,
  MANUAL_MAX_ENTRIES,
  manualFacts,
  parseManualYaml,
  updateManualDeploymentRequestSchema,
  type DeploymentItem,
  type ManualEntry,
} from '@hinomi/shared'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DeploymentRow } from '../../db/schema.js'
import {
  deploymentInputFromRecord,
  type Repositories,
  type Source,
} from '../../repository/index.js'
import { splitRepo } from '../../scan/index.js'
import { manualRecord } from '../../sources/manual/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'

// Manual deployments (docs/design/phase-2.md section 9.5): the entries of a manual source are
// kept as its deployments. Writing one stores it, maps its repo and sets its container facts to
// "no details", so the guards say unknown with a reason; the next scan reads them back through
// the source's inventory and changes nothing. Mounted by the deployments routes.

function requireManualSource(repositories: Repositories, id: number): Source {
  const source = repositories.sources.get(id)
  if (!source) throw notFound('Source')
  if (source.kind !== 'manual') {
    throw new HttpError(
      400,
      'not_supported',
      'Deployments can only be added to a manual list. Hinomi reads the others from their source.',
    )
  }
  return source
}

/** The deployment, when it belongs to a manual source; its source with it. */
function requireManualDeployment(
  repositories: Repositories,
  id: number,
): { deployment: DeploymentRow; source: Source } {
  const deployment = repositories.deployments.get(id)
  if (!deployment) throw notFound('Deployment')
  const source = repositories.sources.get(deployment.sourceId)
  if (source?.kind !== 'manual') {
    throw new HttpError(
      400,
      'not_supported',
      'Only deployments of a manual list can be changed. Hinomi reads the others from their source.',
    )
  }
  return { deployment, source }
}

function entryOf(row: DeploymentRow): ManualEntry {
  return {
    name: row.name,
    repo: row.gitRepository,
    branch: row.gitBranch,
    image: row.image,
    domains: row.domains,
    reach: row.reach,
    server: row.server,
  }
}

/** Stores one entry: maps its repo, writes the deployment with its manual facts. */
function saveEntry(
  repositories: Repositories,
  source: Source,
  externalId: string,
  entry: ManualEntry,
  now: Date,
): DeploymentRow {
  const record = {
    ...manualRecord(source.name, { externalId, ...entry }),
    facts: manualFacts(entry.image, now.toISOString()),
    factsVersion: null,
  }
  const parts = splitRepo(record.repo)
  const repoId = parts ? repositories.repos.upsert(parts).id : null
  return repositories.deployments.upsert(deploymentInputFromRecord(record, source.id, repoId), now)
}

function requireRoom(held: number, adding: number): void {
  if (held + adding > MANUAL_MAX_ENTRIES) {
    throw new HttpError(
      400,
      'validation_failed',
      `A manual list holds ${MANUAL_MAX_ENTRIES} deployments at most.`,
    )
  }
}

function requireFreeName(rows: readonly DeploymentRow[], name: string, exceptId?: number): void {
  const clash = rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())
  if (clash)
    throw new HttpError(409, 'conflict', `The list already has a deployment named "${name}".`)
}

/** Answers a write with the deployment as the deployments list serves it, so the web reads one shape. */
export function manualDeploymentsRoutes(
  deps: ApiDeps,
  toItem: (row: DeploymentRow) => DeploymentItem,
) {
  const app = new Hono()
  const { repositories, now } = deps

  app.post('/', async (c) => {
    const body = await readJson(c, createManualDeploymentRequestSchema)
    const source = requireManualSource(repositories, body.sourceId)
    const rows = repositories.deployments.listBySource(source.id)
    requireFreeName(rows, body.name)
    requireRoom(rows.length, 1)
    const fields = completeManualEntry({
      name: body.name,
      repo: body.repo,
      branch: body.branch,
      image: body.image,
      domains: body.domains,
      reach: body.reach,
      server: body.server,
    })
    const row = repositories.db.transaction(() =>
      saveEntry(repositories, source, randomUUID(), fields, now()),
    )
    return send(c, deploymentItemSchema, toItem(row), 201)
  })

  app.post('/import', async (c) => {
    const body = await readJson(c, importManualDeploymentsRequestSchema)
    const source = requireManualSource(repositories, body.sourceId)
    const parsed = parseManualYaml(body.yaml)
    if (!parsed.ok) throw new HttpError(400, 'validation_failed', parsed.errors.join('\n'))
    const rows = repositories.deployments.listBySource(source.id)
    const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]))
    const fresh = parsed.entries.filter((e) => !byName.has(e.name.toLowerCase())).length
    const kept = body.replace ? 0 : rows.length
    requireRoom(kept, fresh)
    const result = repositories.db.transaction(() => {
      const at = now()
      let created = 0
      let updated = 0
      const listed = new Set<number>()
      for (const entry of parsed.entries) {
        const existing = byName.get(entry.name.toLowerCase())
        const row = saveEntry(repositories, source, existing?.externalId ?? randomUUID(), entry, at)
        listed.add(row.id)
        if (existing) updated++
        else created++
      }
      let removed = 0
      if (body.replace) {
        for (const row of rows) {
          if (!listed.has(row.id) && repositories.deployments.remove(row.id)) removed++
        }
      }
      return { created, updated, removed }
    })
    return send(c, importManualDeploymentsResponseSchema, result)
  })

  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const { deployment, source } = requireManualDeployment(repositories, id)
    const body = await readJson(c, updateManualDeploymentRequestSchema)
    if (body.name !== undefined) {
      requireFreeName(repositories.deployments.listBySource(source.id), body.name, id)
    }
    const current = entryOf(deployment)
    const next: ManualEntry = {
      name: body.name ?? current.name,
      repo: body.repo === undefined ? current.repo : body.repo,
      branch: body.branch === undefined ? current.branch : body.branch || null,
      image: body.image === undefined ? current.image : body.image || null,
      domains: body.domains ? [...new Set(body.domains)] : current.domains,
      reach: body.reach ?? current.reach,
      server: body.server === undefined ? current.server : body.server || null,
    }
    const row = repositories.db.transaction(() =>
      saveEntry(repositories, source, deployment.externalId, next, now()),
    )
    return send(c, deploymentItemSchema, toItem(row))
  })

  app.delete('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    requireManualDeployment(repositories, id)
    repositories.deployments.remove(id)
    return c.body(null, 204)
  })

  return app
}
