import { installerAssets, type RepoReleaseStatus } from '@hinomi/shared'
import { z } from 'zod'
import type { FindingRow, RepoRow } from '../db/schema.js'
import {
  advisoryFindingKey,
  coverageNoteTypeOf,
  releaseAdvisoryFindingKey,
  repoCoverageNoteFindingKey,
  type Repositories,
} from '../repository/index.js'
import { mapLimit } from '../sources/osv/index.js'
import { coveringSources, lockfileObservations, mergeScopes, type FindingChange } from './apply.js'
import { errorMessage, scanLockfilesAt, type OsvRepoResult, type RepoScan } from './collect.js'
import type { DeploymentIndex } from './deployments.js'
import type { ScanSources } from './sources.js'
import { markFixed, reopenIfFixed } from './state.js'

// The desktop release tier (docs/design/phase-2.md section 7). A repo nothing deploys whose
// latest final release ships installers is "released": the version at that tag is in users'
// hands. Once a day per repo the latest release is read through the repo's own GitHub source
// (with its ETag, so an unchanged release costs a 304 that GitHub does not count). Every scan then
// reads the lockfiles at that tag and checks them against OSV, like the default branch.

/** How often the latest release of a repo is asked for. */
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Installer asset names kept per release, for the repo detail. */
export const MAX_INSTALLER_ASSETS = 50

/** The http_cache entry holding the ETag of a repo's latest release and what it said. */
export function releaseCacheKey(repoId: number): string {
  return `github:release:latest:${repoId}`
}

const cachedReleaseSchema = z.object({
  tag: z.string(),
  publishedAt: z.string().nullable(),
  installerAssets: z.array(z.string()),
})
type CachedRelease = z.infer<typeof cachedReleaseSchema>

/** The installer asset names stored with the repo's latest release; empty when none or unread. */
export function cachedInstallerAssets(repositories: Repositories, repoId: number): string[] {
  const entry = repositories.httpCache.get(releaseCacheKey(repoId))
  if (!entry) return []
  try {
    const parsed = cachedReleaseSchema.safeParse(JSON.parse(entry.body.toString('utf8')))
    return parsed.success ? parsed.data.installerAssets : []
  } catch {
    return []
  }
}

/**
 * Where a repo stands in the desktop tier, from what is stored. A deployment (stopped ones too)
 * always wins: a deployed repo keeps its deploy tiers. `on` needs only a latest release, `auto`
 * also needs installer like assets (decision Q16).
 */
export function releaseStatus(
  repo: Pick<
    RepoRow,
    'releaseTier' | 'latestReleaseTag' | 'releaseInstallers' | 'releaseCheckedAt'
  >,
  deployed: boolean,
): RepoReleaseStatus {
  if (deployed) return 'deployed'
  if (repo.releaseTier === 'off') return 'turned_off'
  if (repo.latestReleaseTag === null) {
    return repo.releaseCheckedAt === null ? 'not_checked' : 'no_release'
  }
  if (repo.releaseTier === 'on') return 'released'
  return repo.releaseInstallers === true ? 'released' : 'no_installers'
}

/** True when the repo's latest release has not been asked for in the last day. */
export function isReleaseCheckDue(repo: Pick<RepoRow, 'releaseCheckedAt'>, now: Date): boolean {
  return (
    repo.releaseCheckedAt === null ||
    now.getTime() - repo.releaseCheckedAt.getTime() >= RELEASE_CHECK_INTERVAL_MS
  )
}

function parseDate(raw: string | null): Date | null {
  if (raw === null) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Asks GitHub for the repo's latest final release with the stored ETag and stores the answer on
 * the repo. A 304 only moves the check time. Throws when GitHub fails (nothing is changed then).
 */
export async function checkLatestRelease(
  repositories: Repositories,
  github: ScanSources['github'][number],
  repo: Pick<RepoRow, 'id' | 'owner' | 'name'>,
  now: Date,
): Promise<void> {
  const key = releaseCacheKey(repo.id)
  const etag = repositories.httpCache.get(key)?.etag ?? null
  const read = await github.fetchLatestRelease(repo.owner, repo.name, etag)
  if (!read.modified) {
    repositories.repos.recordReleaseCheck(repo.id, undefined, now)
    repositories.httpCache.touch(key, now)
    return
  }
  if (read.value === null) {
    repositories.repos.recordReleaseCheck(repo.id, null, now)
    repositories.httpCache.remove(key)
    return
  }
  const assets = installerAssets(read.value.assetNames).slice(0, MAX_INSTALLER_ASSETS)
  const cached: CachedRelease = {
    tag: read.value.tag,
    publishedAt: read.value.publishedAt,
    installerAssets: assets,
  }
  repositories.db.transaction(() => {
    repositories.repos.recordReleaseCheck(
      repo.id,
      {
        tag: cached.tag,
        publishedAt: parseDate(cached.publishedAt),
        installers: assets.length > 0,
      },
      now,
    )
    repositories.httpCache.put({
      key,
      etag: read.etag,
      lastModified: null,
      fetchedAt: now,
      status: 200,
      body: Buffer.from(JSON.stringify(cached), 'utf8'),
    })
  })
}

/** True for a desktop release advisory or a repo's `release_lockfile_missing` note. */
export function isReleaseFinding(finding: FindingRow): boolean {
  return (
    (finding.kind === 'advisory' && finding.releaseTag !== null) ||
    coverageNoteTypeOf(finding) === 'release_lockfile_missing'
  )
}

function releaseFindingsOf(repositories: Repositories, repoId: number): FindingRow[] {
  return repositories.findings.list({ repoId }).filter(isReleaseFinding)
}

/**
 * The repo left the tier (deployed, turned off, no release, no installers): its release rows and
 * note are resolved, with the reason on the event.
 */
export function resolveRelease(
  repositories: Repositories,
  repoId: number,
  reason: Exclude<RepoReleaseStatus, 'released' | 'not_checked'>,
  now: Date,
): FindingChange[] {
  return repositories.db.transaction(() => {
    const changes: FindingChange[] = []
    for (const finding of releaseFindingsOf(repositories, repoId)) {
      if (markFixed(repositories.findings, finding, now, { reason, release: true })) {
        changes.push({ findingId: finding.id, change: 'fixed' })
      }
    }
    return changes
  })
}

/**
 * For each advisory at the tag: true when the default branch no longer has it (its finding is
 * gone, fixed or patched in the lockfile), so a patched release is due. Undefined when this scan
 * could not read the default branch, which leaves the stored answer alone.
 */
export function fixedOnDefaultBranchOf(
  repositories: Repositories,
  repoId: number,
  main: RepoScan | undefined,
): (advisoryId: number) => boolean | undefined {
  if (!main || coveringSources(main).size === 0) return () => undefined
  return (advisoryId) => {
    const finding = repositories.findings.getByKey(advisoryFindingKey(advisoryId, repoId))
    return !finding || finding.state === 'fixed' || finding.patchedInLockfile
  }
}

/** Opens (or reopens) the repo's `release_lockfile_missing` note, or resolves it. */
function applyLockfileNote(
  repositories: Repositories,
  repoId: number,
  tag: string,
  missing: boolean,
  now: Date,
  changes: FindingChange[],
): void {
  const { findings } = repositories
  if (!missing) {
    const note = findings.getByKey(repoCoverageNoteFindingKey('release_lockfile_missing', repoId))
    if (note && markFixed(findings, note, now, { releaseTag: tag })) {
      changes.push({ findingId: note.id, change: 'fixed' })
    }
    return
  }
  const { finding, created } = findings.observe(
    { kind: 'coverage_note', coverageNoteType: 'release_lockfile_missing', repoId },
    now,
  )
  if (created) changes.push({ findingId: finding.id, change: 'opened' })
  else if (reopenIfFixed(findings, finding, now)) {
    changes.push({ findingId: finding.id, change: 'reopened' })
  }
}

/**
 * Writes what OSV found at the release tag: one release row per advisory (keyed apart from the
 * default branch row, `release_tag` set), reopened when it comes back, fixed when a fully read tag
 * no longer has it. No readable lockfile at the tag opens `release_lockfile_missing` and leaves
 * the rows as they are (the released version cannot be checked, which is not the same as clean).
 */
export function applyReleaseAdvisories(
  repositories: Repositories,
  repoId: number,
  tag: string,
  osv: OsvRepoResult,
  fixedOnDefaultBranch: (advisoryId: number) => boolean | undefined,
  now: Date,
): FindingChange[] {
  return repositories.db.transaction(() => {
    const { findings } = repositories
    const changes: FindingChange[] = []
    applyLockfileNote(repositories, repoId, tag, osv.lockfiles.length === 0, now, changes)
    const seen = new Set<number>()
    for (const obs of lockfileObservations(repositories, osv)) {
      const fixedOnMain = fixedOnDefaultBranch(obs.advisoryId)
      const key = releaseAdvisoryFindingKey(obs.advisoryId, repoId)
      const before = findings.getByKey(key)?.fixedOnDefaultBranch ?? false
      const { finding, created } = findings.observe(
        {
          kind: 'advisory',
          advisoryId: obs.advisoryId,
          repoId,
          scope: mergeScopes(obs.scopes),
          reportedBy: [...obs.reporters],
          manifestPaths: [...obs.manifestPaths],
          ...(obs.installedVersion !== undefined && { installedVersion: obs.installedVersion }),
          patchedInLockfile: false,
          ...(obs.dependencyPath !== undefined && { dependencyPath: obs.dependencyPath }),
          releaseTag: tag,
          ...(fixedOnMain !== undefined && { fixedOnDefaultBranch: fixedOnMain }),
        },
        now,
      )
      seen.add(finding.id)
      if (created) changes.push({ findingId: finding.id, change: 'opened' })
      else if (reopenIfFixed(findings, finding, now)) {
        changes.push({ findingId: finding.id, change: 'reopened' })
      }
      if (fixedOnMain === true && !before) {
        findings.addEvent({
          findingId: finding.id,
          type: 'fixed_on_default_branch',
          actor: 'system',
          data: { releaseTag: tag },
          at: now,
        })
      }
    }
    // Only a tag whose every lockfile was read can say an advisory is gone.
    if (osv.lockfiles.length === 0 || osv.unparseable.length > 0) return changes
    for (const finding of releaseFindingsOf(repositories, repoId)) {
      if (finding.kind !== 'advisory' || seen.has(finding.id)) continue
      if (markFixed(findings, finding, now, { releaseTag: tag, coveredBy: ['osv'] })) {
        changes.push({ findingId: finding.id, change: 'fixed' })
      }
    }
    return changes
  })
}

export interface ReleaseScanInput {
  repositories: Repositories
  sources: ScanSources
  index: DeploymentIndex
  /** Repos this scan read; the ones nothing deploys are the candidates. */
  repos: readonly RepoRow[]
  /** The default branch scans of this run, by repo id (for the reading source and "fixed on main"). */
  scans: ReadonlyMap<number, RepoScan>
  now: Date
  concurrency: number
}

export interface ReleaseScanError {
  source: 'github' | 'osv'
  subject: string
  error: string
}

export interface ReleaseScanResult {
  changes: FindingChange[]
  errors: ReleaseScanError[]
  /** Latest releases asked of GitHub this scan. */
  checked: number
  /** Release tags whose lockfiles were read and checked. */
  scanned: number
}

/**
 * The desktop tier step of a full scan. Repos with release rows that got a deployment are
 * resolved. Every scanned repo nothing deploys gets its daily release check when due (through
 * the GitHub source that read it), then, when released and OSV is on, its tag scanned. A failed
 * read leaves that repo's rows alone and is returned as an error. Never throws for one repo.
 */
export async function scanReleases(input: ReleaseScanInput): Promise<ReleaseScanResult> {
  const { repositories, sources, index, scans, now } = input
  const result: ReleaseScanResult = { changes: [], errors: [], checked: 0, scanned: 0 }
  const name = (repo: RepoRow) => `${repo.owner}/${repo.name}`

  const withRows = new Set(
    repositories.findings
      .list()
      .filter((f) => f.repoId !== null && isReleaseFinding(f))
      .map((f) => f.repoId!),
  )
  for (const repoId of withRows) {
    if (index.byRepo.has(repoId)) {
      result.changes.push(...resolveRelease(repositories, repoId, 'deployed', now))
    }
  }

  const candidates = input.repos.filter((r) => !index.byRepo.has(r.id))
  const github = new Map(sources.github.map((g) => [g.sourceId, g]))
  await mapLimit(candidates, input.concurrency, async (candidate) => {
    const scan = scans.get(candidate.id)
    const sourceId = scan?.sourceId ?? null
    const source = sourceId === null ? undefined : github.get(sourceId)
    if (candidate.releaseTier !== 'off' && source && isReleaseCheckDue(candidate, now)) {
      try {
        await checkLatestRelease(repositories, source, candidate, now)
        result.checked++
      } catch (error) {
        result.errors.push({
          source: 'github',
          subject: `${name(candidate)} latest release`,
          error: errorMessage(error),
        })
      }
    }
    const repo = repositories.repos.get(candidate.id) ?? candidate
    const status = releaseStatus(repo, false)
    if (status === 'not_checked') return
    if (status !== 'released') {
      result.changes.push(...resolveRelease(repositories, repo.id, status, now))
      return
    }
    // OSV is the only way to check a tag (Dependabot covers the default branch only). Off: the
    // rows stay as they are, like the default branch rows OSV reported.
    const osv = sources.osv
    const tag = repo.latestReleaseTag
    if (!osv || tag === null) return
    let read: OsvRepoResult
    try {
      read = await scanLockfilesAt(sources, osv, repo, tag, sourceId)
    } catch (error) {
      result.errors.push({
        source: 'osv',
        subject: `${name(repo)}@${tag}`,
        error: errorMessage(error),
      })
      return
    }
    result.scanned++
    const fixedOnMain = fixedOnDefaultBranchOf(repositories, repo.id, scan)
    result.changes.push(
      ...applyReleaseAdvisories(repositories, repo.id, tag, read, fixedOnMain, now),
    )
  })
  return result
}
