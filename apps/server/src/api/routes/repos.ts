import {
  idParamSchema,
  repoDetailSchema,
  updateRepoRequestSchema,
  type RepoDetail,
  type RepoSourceRef,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { RepoRow } from '../../db/schema.js'
import {
  isUsableGithubSource,
  resolveRepoSource,
  type Repositories,
  type Source,
} from '../../repository/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'
import { toRepoRef } from '../serialize.js'

function sourceRef(source: Source): RepoSourceRef {
  return { id: source.id, name: source.name, auth: source.auth, enabled: source.enabled }
}

/** The repo with the GitHub source it is read and fixed through, and the sources that see it. */
export function toRepoDetail(repositories: Repositories, repo: RepoRow): RepoDetail {
  const resolved = resolveRepoSource(repositories.sources, repo)
  const github = new Map(repositories.sources.listByKind('github').map((s) => [s.id, s]))
  const seenBy = repositories.repoSources.seenBy(repo.id).flatMap((row) => {
    const source = github.get(row.sourceId)
    if (!source) return []
    return [
      {
        ...sourceRef(source),
        alertsReadable: row.alertsReadable,
        lastSeenAt: row.lastSeenAt.toISOString(),
      },
    ]
  })
  return {
    ...toRepoRef(repo),
    source: {
      current: resolved.source && sourceRef(resolved.source),
      mode: resolved.mode,
      overrideId: repo.sourceOverrideId,
      seenBy,
    },
  }
}

/** GET and PATCH /api/repos/:id: the repo and the GitHub source it uses. */
export function repoDetailRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  const requireRepo = (id: number): RepoRow => {
    const repo = repositories.repos.get(id)
    if (!repo) throw notFound('Repo')
    return repo
  }

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    return send(c, repoDetailSchema, toRepoDetail(repositories, requireRepo(id)))
  })

  app.patch('/:id', async (c) => {
    const { id } = readParams(c, idParamSchema)
    requireRepo(id)
    const { sourceId } = await readJson(c, updateRepoRequestSchema)
    if (sourceId !== null) {
      const source = repositories.sources.get(sourceId)
      if (!source || source.kind !== 'github') throw notFound('GitHub source')
      if (!isUsableGithubSource(source)) {
        throw new HttpError(
          409,
          'conflict',
          `GitHub source "${source.name}" is switched off or has no credential.`,
        )
      }
    }
    const repo = repositories.repoSources.setOverride(id, sourceId) ?? requireRepo(id)
    return send(c, repoDetailSchema, toRepoDetail(repositories, repo))
  })

  return app
}
