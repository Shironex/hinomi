import {
  idParamSchema,
  repoDetailSchema,
  updateRepoReleaseTierRequestSchema,
  updateRepoRequestSchema,
  type RepoDetail,
  type RepoRelease,
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
import {
  cachedInstallerAssets,
  indexDeployments,
  isReleaseFinding,
  lockfileRef,
  releaseStatus,
  repoRuntimeView,
} from '../../scan/index.js'
import { readBehindReleases, readSupportWindowDays } from '../../support/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'
import { toRepoRef } from '../serialize.js'

function sourceRef(source: Source): RepoSourceRef {
  return { id: source.id, name: source.name, auth: source.auth, enabled: source.enabled }
}

const isOpen = (state: string) => state === 'open' || state === 'fixing'

/** The repo's latest release, its desktop tier status and what the tag scan found. */
export function toRepoRelease(repositories: Repositories, repo: RepoRow): RepoRelease {
  const deployed = indexDeployments(repositories).byRepo.has(repo.id)
  const rows = repositories.findings.list({ repoId: repo.id }).filter(isReleaseFinding)
  const advisories = rows.filter((f) => f.kind === 'advisory' && isOpen(f.state))
  return {
    tier: repo.releaseTier,
    status: releaseStatus(repo, deployed),
    latestTag: repo.latestReleaseTag,
    latestAt: repo.latestReleaseAt?.toISOString() ?? null,
    installers: repo.releaseInstallers,
    installerAssets:
      repo.latestReleaseTag === null ? [] : cachedInstallerAssets(repositories, repo.id),
    checkedAt: repo.releaseCheckedAt?.toISOString() ?? null,
    openFindings: advisories.length,
    fixedOnDefaultBranch: advisories.filter((f) => f.fixedOnDefaultBranch).length,
    lockfileMissing: rows.some((f) => f.kind === 'coverage_note' && f.state !== 'fixed'),
  }
}

/**
 * The runtime pins the last scan stored at the branch it reads (the deployed branch, else the
 * default one), judged with the current support data and settings.
 */
function runtimeOf(deps: Pick<ApiDeps, 'repositories' | 'support' | 'now'>, repo: RepoRow) {
  const { repositories } = deps
  const deployments = indexDeployments(repositories).byRepo.get(repo.id) ?? []
  const ref = lockfileRef(repo, deployments, null)
  const pins = ref === null ? [] : repositories.runtimePins.list(repo.id, ref)
  return repoRuntimeView(pins, deps.support.index(), {
    now: deps.now(),
    windowDays: readSupportWindowDays(repositories.settings),
    behindReleases: readBehindReleases(repositories.settings),
  })
}

/**
 * The repo with the GitHub source it is read and fixed through, the sources that see it, and its
 * runtime pins and support lines.
 */
export function toRepoDetail(
  deps: Pick<ApiDeps, 'repositories' | 'support' | 'now'>,
  repo: RepoRow,
): RepoDetail {
  const { repositories } = deps
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
    release: toRepoRelease(repositories, repo),
    ...runtimeOf(deps, repo),
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
    return send(c, repoDetailSchema, toRepoDetail(deps, requireRepo(id)))
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
    return send(c, repoDetailSchema, toRepoDetail(deps, repo))
  })

  // The desktop tier mode. The next scan asks GitHub for the latest release again and moves the
  // repo's release findings in or out of the tier.
  app.put('/:id/release-tier', async (c) => {
    const { id } = readParams(c, idParamSchema)
    requireRepo(id)
    const { tier } = await readJson(c, updateRepoReleaseTierRequestSchema)
    const repo = repositories.repos.setReleaseTier(id, tier) ?? requireRepo(id)
    return send(c, repoDetailSchema, toRepoDetail(deps, repo))
  })

  return app
}
