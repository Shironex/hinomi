import {
  createSourceRequestSchema,
  idParamSchema,
  sourceSchema,
  sourcesResponseSchema,
  sourceTestResultSchema,
  testSourceRequestSchema,
  updateSourceRequestSchema,
  type SourceKind,
  type SourceTestResult,
} from '@hinomi/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Repositories, Source } from '../../repository/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'
import { toSourceDto } from '../serialize.js'

const emptyBodySchema = z.strictObject({})

const SECRET_KEY_MISSING =
  'HINOMI_SECRET_KEY is not set on the server, so tokens cannot be stored. Set it (for example to the output of `openssl rand -base64 32`) and restart Hinomi.'

function requireTokenStorage(repositories: Repositories): void {
  if (!repositories.sources.canStoreTokens) {
    throw new HttpError(400, 'secret_key_missing', SECRET_KEY_MISSING)
  }
}

function requireSource(repositories: Repositories, id: number): Source {
  const source = repositories.sources.get(id)
  if (!source) throw notFound('Source')
  return source
}

function requireUniqueName(
  repositories: Repositories,
  kind: SourceKind,
  name: string,
  exceptId?: number,
) {
  const clash = repositories.sources
    .listByKind(kind)
    .some((s) => s.name === name && s.id !== exceptId)
  if (clash) throw new HttpError(409, 'conflict', `A ${kind} source named "${name}" already exists`)
}

interface SourceShape {
  kind: SourceKind
  baseUrl: string | null
  hasToken: boolean
}

/** What each kind needs: Coolify a URL and a token, GitHub a token, OSV neither. */
function checkShape({ kind, baseUrl, hasToken }: SourceShape): void {
  if (kind === 'osv') {
    if (baseUrl || hasToken) {
      throw new HttpError(400, 'validation_failed', 'OSV takes no URL and no token')
    }
    return
  }
  if (kind === 'coolify' && !baseUrl) {
    throw new HttpError(400, 'validation_failed', 'A Coolify source needs its URL')
  }
  if (!hasToken) {
    throw new HttpError(400, 'validation_failed', `A ${kind} source needs a token`)
  }
}

async function runTest(
  deps: ApiDeps,
  kind: SourceKind,
  baseUrl: string | null,
  token: string,
): Promise<SourceTestResult> {
  if (kind === 'coolify') {
    if (!baseUrl) throw new HttpError(400, 'validation_failed', 'A Coolify source needs its URL')
    return deps.testers.coolify({ baseUrl, token })
  }
  if (kind === 'github') return deps.testers.github({ baseUrl, token })
  throw new HttpError(400, 'not_supported', 'OSV.dev needs no connection test')
}

export function sourcesRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/', (c) =>
    send(c, sourcesResponseSchema, {
      sources: repositories.sources.list().map(toSourceDto),
      canStoreTokens: repositories.sources.canStoreTokens,
    }),
  )

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    return send(c, sourceSchema, toSourceDto(requireSource(repositories, id)))
  })

  app.post('/', async (c) => {
    const body = await readJson(c, createSourceRequestSchema)
    const baseUrl = body.baseUrl ?? null
    checkShape({ kind: body.kind, baseUrl, hasToken: body.token !== undefined })
    if (body.token !== undefined) requireTokenStorage(repositories)
    requireUniqueName(repositories, body.kind, body.name)
    const source = repositories.sources.create({
      kind: body.kind,
      name: body.name,
      baseUrl,
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.token !== undefined && { token: body.token }),
    })
    scheduler.reschedule()
    return send(c, sourceSchema, toSourceDto(source), 201)
  })

  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const current = requireSource(repositories, id)
    const body = await readJson(c, updateSourceRequestSchema)
    const baseUrl = body.baseUrl === undefined ? current.baseUrl : body.baseUrl
    checkShape({
      kind: current.kind,
      baseUrl,
      hasToken: body.token !== undefined || current.hasToken,
    })
    if (body.token !== undefined) requireTokenStorage(repositories)
    if (body.name !== undefined) requireUniqueName(repositories, current.kind, body.name, id)
    repositories.db.transaction(() => {
      const fields = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      }
      if (Object.keys(fields).length > 0) repositories.sources.update(id, fields)
      if (body.token !== undefined) repositories.sources.setToken(id, body.token)
    })
    scheduler.reschedule()
    return send(c, sourceSchema, toSourceDto(requireSource(repositories, id)))
  })

  app.delete('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    requireSource(repositories, id)
    repositories.sources.remove(id)
    scheduler.reschedule()
    return c.body(null, 204)
  })

  /** Tests credentials that are not saved yet (onboarding). Nothing is stored. */
  app.post('/test', async (c) => {
    const body = await readJson(c, testSourceRequestSchema)
    const result = await runTest(deps, body.kind, body.baseUrl ?? null, body.token)
    return send(c, sourceTestResultSchema, result)
  })

  /** Tests a saved source with its stored token. */
  app.post('/:id/test', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const source = requireSource(repositories, id)
    await readJson(c, emptyBodySchema)
    if (source.kind === 'osv') {
      throw new HttpError(400, 'not_supported', 'OSV.dev needs no connection test')
    }
    if (!source.hasToken) throw new HttpError(400, 'bad_request', 'This source has no token')
    const token = repositories.sources.getToken(id)
    if (!token) throw new HttpError(400, 'bad_request', 'This source has no token')
    const result = await runTest(deps, source.kind, source.baseUrl, token)
    return send(c, sourceTestResultSchema, result)
  })

  return app
}
