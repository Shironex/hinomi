import {
  dispatchFixRunRequestSchema,
  dispatchFixRunResponseSchema,
  fixRunDetailSchema,
  fixRunReopenRequiredSchema,
  fixRunsQuerySchema,
  fixRunsResponseSchema,
  idParamSchema,
  runnerStatusSchema,
  setupPrResponseSchema,
  updateRunnerSettingsRequestSchema,
} from '@hinomi/shared'
import { Hono, type Context } from 'hono'
import type { RepoRow } from '../../db/schema.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, readQuery, send } from '../http.js'
import { toFixRun, toFixRunTracking, toFixRunVerify } from '../serialize.js'

// The GitHub Actions fix runner per repo (settings, status) and its fix runs (dispatch, list,
// detail). See docs/api.md "Fix runner and fix runs".

async function statusResponse(c: Context, deps: ApiDeps, repo: RepoRow) {
  const status = await deps.fixRuns.status(repo)
  return send(c, runnerStatusSchema, {
    ...status,
    latestRun: status.latestRun ? toFixRun(status.latestRun) : null,
  })
}

/** /api/repos/:id/runner and /api/repos/:id/fix-runs. */
export function repoFixRunsRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  const repoOf = (c: Context): RepoRow => {
    const { id } = readParams(c, idParamSchema)
    const repo = repositories.repos.get(id)
    if (!repo) throw notFound('Repo')
    return repo
  }

  app.get('/:id/runner', async (c) => statusResponse(c, deps, repoOf(c)))

  app.patch('/:id/runner', async (c) => {
    const repo = repoOf(c)
    const patch = await readJson(c, updateRunnerSettingsRequestSchema)
    const updated = deps.fixRuns.updateSettings(repo.id, patch)
    if (!updated) throw notFound('Repo')
    deps.log.info('runner: settings changed', {
      repoId: repo.id,
      enabled: updated.runnerEnabled,
      workflow: updated.runnerWorkflow,
    })
    return statusResponse(c, deps, updated)
  })

  app.post('/:id/runner/setup-pr', async (c) => {
    const repo = repoOf(c)
    const result = await deps.fixRuns.setupPr(repo.id)
    if (result.kind === 'refused') throw new HttpError(result.status, result.code, result.message)
    deps.log.info('runner: setup pr', {
      repoId: repo.id,
      outcome: result.response.outcome,
      pr: result.response.pr?.number ?? null,
    })
    return send(c, setupPrResponseSchema, result.response, result.created ? 201 : 200)
  })

  app.get('/:id/fix-runs', (c) => {
    const repo = repoOf(c)
    const { kind, limit } = readQuery(c, fixRunsQuerySchema)
    const rows = repositories.fixRuns.listByRepo(repo.id, {
      ...(kind && { kind }),
      ...(limit !== undefined && { limit }),
    })
    return send(c, fixRunsResponseSchema, { items: rows.map(toFixRun) })
  })

  app.post('/:id/fix-runs', async (c) => {
    const repo = repoOf(c)
    const body = await readJson(c, dispatchFixRunRequestSchema)
    const result = await deps.fixRuns.dispatch(repo.id, body)
    switch (result.kind) {
      case 'refused':
        throw new HttpError(result.status, result.code, result.message)
      case 'reopen_required':
        return send(
          c,
          fixRunReopenRequiredSchema,
          {
            error: {
              code: 'conflict',
              message: `The last fix PR #${result.previous.pr.number} was closed without merging. Send confirmReopen: true to open a fresh one.`,
            },
            previous: result.previous,
          },
          409,
        )
      case 'created':
        deps.log.info('runner: fix run dispatched', {
          repoId: repo.id,
          runId: result.run.id,
          state: result.run.state,
          encoding: result.encoding,
          omittedSteps: result.omittedStepIds.length,
        })
        return send(
          c,
          dispatchFixRunResponseSchema,
          {
            run: toFixRun(result.run),
            encoding: result.encoding,
            omittedStepIds: result.omittedStepIds,
          },
          201,
        )
    }
  })

  return app
}

/** GET /api/fix-runs/:id: the run with the tracker's state, deployments and verification. */
export function fixRunsRoutes(deps: ApiDeps) {
  const app = new Hono()
  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    const run = deps.repositories.fixRuns.get(id)
    if (!run) throw notFound('Fix run')
    const tracking = deps.fixRunTracking?.status(run) ?? null
    return send(c, fixRunDetailSchema, {
      ...toFixRun(run),
      tracking: tracking && toFixRunTracking(tracking),
      ...toFixRunVerify(run),
    })
  })
  return app
}
