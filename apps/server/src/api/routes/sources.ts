import {
  createSourceRequestSchema,
  idParamSchema,
  sourceSchema,
  sourcesResponseSchema,
  sourceTestResultSchema,
  testSourceRequestSchema,
  updateSourceRequestSchema,
  type SourceAuth,
  type SourceDto,
  type SourceKind,
  type SourceTestResult,
} from '@hinomi/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Repositories, Source } from '../../repository/index.js'
import { isGithubError, readAppPrivateKey } from '../../sources/github/index.js'
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

function invalid(message: string): HttpError {
  return new HttpError(400, 'validation_failed', message)
}

/** Refuses a PEM node:crypto cannot read, so a broken key is caught when it is entered. */
function requireReadableKey(privateKey: string): void {
  try {
    readAppPrivateKey(privateKey)
  } catch (error) {
    if (isGithubError(error)) throw invalid(error.message)
    throw error
  }
}

interface AppFields {
  token?: string | undefined
  appId?: string | undefined
  installationId?: string | undefined
  privateKey?: string | undefined
}

/**
 * Checks that the fields sent fit the auth kind and returns the secret to store, if any:
 * the token for token auth, the private key for a GitHub App.
 */
function secretFor(kind: SourceKind, auth: SourceAuth, body: AppFields): string | undefined {
  if (auth === 'github_app') {
    if (kind !== 'github') throw invalid('Only GitHub sources can sign in as a GitHub App')
    if (body.token !== undefined) {
      throw invalid('A GitHub App source takes a private key, not a token')
    }
    if (body.privateKey !== undefined) requireReadableKey(body.privateKey)
    return body.privateKey
  }
  if (body.appId !== undefined || body.installationId !== undefined) {
    throw invalid('App and installation IDs only apply to a GitHub App source')
  }
  if (body.privateKey !== undefined) {
    throw invalid('A private key only applies to a GitHub App source')
  }
  return body.token
}

type TestCredentials =
  | { auth: 'token'; token: string }
  | { auth: 'github_app'; appId: string; installationId: string; privateKey: string }

async function runTest(
  deps: ApiDeps,
  kind: SourceKind,
  baseUrl: string | null,
  credentials: TestCredentials,
): Promise<SourceTestResult> {
  if (credentials.auth === 'github_app') {
    const { appId, installationId, privateKey } = credentials
    return deps.testers.githubApp({ baseUrl, appId, installationId, privateKey })
  }
  const { token } = credentials
  if (kind === 'coolify') {
    if (!baseUrl) throw new HttpError(400, 'validation_failed', 'A Coolify source needs its URL')
    return deps.testers.coolify({ baseUrl, token })
  }
  if (kind === 'github') return deps.testers.github({ baseUrl, token })
  throw new HttpError(400, 'not_supported', 'OSV.dev needs no connection test')
}

/** Every source as the API serves it, with the repos and deployments it holds. */
function sourceDtos(repositories: Repositories, list: Source[]): SourceDto[] {
  const repoCounts = repositories.repoSources.repoCounts()
  const deploymentCounts = new Map<number, number>()
  for (const d of repositories.deployments.list()) {
    deploymentCounts.set(d.sourceId, (deploymentCounts.get(d.sourceId) ?? 0) + 1)
  }
  return list.map((source) =>
    toSourceDto(source, {
      repoCount: source.kind === 'github' ? (repoCounts.get(source.id) ?? 0) : 0,
      deploymentCount: deploymentCounts.get(source.id) ?? 0,
    }),
  )
}

function sourceDto(repositories: Repositories, source: Source): SourceDto {
  return sourceDtos(repositories, [source])[0]!
}

export function sourcesRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/', (c) =>
    send(c, sourcesResponseSchema, {
      sources: sourceDtos(repositories, repositories.sources.list()),
      canStoreTokens: repositories.sources.canStoreTokens,
    }),
  )

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    return send(c, sourceSchema, sourceDto(repositories, requireSource(repositories, id)))
  })

  app.post('/', async (c) => {
    const body = await readJson(c, createSourceRequestSchema)
    const baseUrl = body.baseUrl ?? null
    const auth = body.auth ?? 'token'
    const secret = secretFor(body.kind, auth, body)
    if (auth === 'github_app') {
      if (body.appId === undefined || body.installationId === undefined || secret === undefined) {
        throw invalid(
          'A GitHub App source needs the App ID, the installation ID and the private key',
        )
      }
    }
    checkShape({ kind: body.kind, baseUrl, hasToken: secret !== undefined })
    if (secret !== undefined) requireTokenStorage(repositories)
    requireUniqueName(repositories, body.kind, body.name)
    const source = repositories.sources.create({
      kind: body.kind,
      name: body.name,
      baseUrl,
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(secret !== undefined && { token: secret }),
      ...(auth === 'github_app' && {
        auth,
        appId: body.appId ?? null,
        installationId: body.installationId ?? null,
      }),
    })
    scheduler.reschedule()
    return send(c, sourceSchema, sourceDto(repositories, source), 201)
  })

  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    const current = requireSource(repositories, id)
    const body = await readJson(c, updateSourceRequestSchema)
    const baseUrl = body.baseUrl === undefined ? current.baseUrl : body.baseUrl
    const auth = body.auth ?? current.auth
    const switching = auth !== current.auth
    const secret = secretFor(current.kind, auth, body)
    // The old secret belongs to the other way of signing in, so a switch brings its own.
    if (switching && secret === undefined) {
      throw invalid(
        auth === 'github_app'
          ? 'Switching to a GitHub App needs its private key'
          : 'Switching to a token needs the token',
      )
    }
    const appId = auth === 'github_app' ? (body.appId ?? current.appId) : null
    const installationId =
      auth === 'github_app' ? (body.installationId ?? current.installationId) : null
    if (auth === 'github_app' && (appId === null || installationId === null)) {
      throw invalid('A GitHub App source needs the App ID and the installation ID')
    }
    checkShape({
      kind: current.kind,
      baseUrl,
      hasToken: secret !== undefined || current.hasToken,
    })
    if (secret !== undefined) requireTokenStorage(repositories)
    if (body.name !== undefined) requireUniqueName(repositories, current.kind, body.name, id)
    repositories.db.transaction(() => {
      const fields = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...((switching || body.appId !== undefined || body.installationId !== undefined) && {
          auth,
          appId,
          installationId,
        }),
      }
      if (Object.keys(fields).length > 0) repositories.sources.update(id, fields)
      if (secret !== undefined) repositories.sources.setToken(id, secret)
    })
    scheduler.reschedule()
    return send(c, sourceSchema, sourceDto(repositories, requireSource(repositories, id)))
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
    const credentials: TestCredentials =
      body.auth === 'github_app'
        ? {
            auth: 'github_app',
            appId: body.appId,
            installationId: body.installationId,
            privateKey: body.privateKey,
          }
        : { auth: 'token', token: body.token }
    const result = await runTest(deps, body.kind, body.baseUrl ?? null, credentials)
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
    const secret = repositories.sources.getToken(id)
    if (!secret) throw new HttpError(400, 'bad_request', 'This source has no token')
    const credentials: TestCredentials =
      source.auth === 'github_app' && source.appId !== null && source.installationId !== null
        ? {
            auth: 'github_app',
            appId: source.appId,
            installationId: source.installationId,
            privateKey: secret,
          }
        : { auth: 'token', token: secret }
    const result = await runTest(deps, source.kind, source.baseUrl, credentials)
    return send(c, sourceTestResultSchema, result)
  })

  return app
}
