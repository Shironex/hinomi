import type {
  DependabotAlertsResult,
  LockfileDependency,
  OsvAdvisoryMatch,
  RepoHealth,
} from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../db/schema.js'
import {
  dedupeDependencies,
  hasLockfileParser,
  parseLockfile,
  scanDependencies,
} from '../sources/osv/index.js'
import { lockfileRef } from './deployments.js'
import { resolveOwnership, type SourceProbe } from './ownership.js'
import type { GithubScanSource, OsvScanSource, ScanSources } from './sources.js'

/** What one source said about one repo in this scan. */
export type SourceOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string }

export interface OsvRepoResult {
  matches: OsvAdvisoryMatch[]
  /** Lockfiles found and read. */
  lockfiles: string[]
  /** Lockfiles found but not readable. */
  unparseable: { path: string; error: string }[]
  /** Every package of every lockfile read, with its lockfile; fills versions for GitHub alerts. */
  dependencies?: LockfileDependency[]
}

export interface RepoScan {
  repo: RepoRow
  deployed: boolean
  health: SourceOutcome<RepoHealth>
  alerts: SourceOutcome<DependabotAlertsResult>
  osv: SourceOutcome<OsvRepoResult>
  /** The GitHub source that read the repo in this scan. Undefined in hand-built scans. */
  sourceId?: number | null
  /** What each GitHub source asked said. Undefined in hand-built scans. */
  probes?: SourceProbe[]
}

/** Error text for the UI and the scan run. Source errors never carry tokens. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function attempt<T>(fn: () => Promise<T>): Promise<SourceOutcome<T>> {
  try {
    return { status: 'ok', value: await fn() }
  } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }
}

async function collectAlerts(
  github: GithubScanSource | null,
  repo: RepoRow,
  health: SourceOutcome<RepoHealth>,
): Promise<SourceOutcome<DependabotAlertsResult>> {
  if (health.status === 'skipped') return { status: 'skipped', reason: health.reason }
  if (!github || health.status !== 'ok') {
    return { status: 'skipped', reason: 'repo health unavailable' }
  }
  if (health.value.alertsEnabled === false)
    return { status: 'skipped', reason: 'Dependabot alerts are disabled' }
  if (health.value.alertsEnabled === null)
    return { status: 'skipped', reason: 'no permission to read Dependabot alerts' }
  return attempt(() => github.fetchDependabotAlerts(repo.owner, repo.name))
}

function parseAll(files: Awaited<ReturnType<ScanSources['fetchLockfiles']>>) {
  const deps: LockfileDependency[] = []
  const lockfiles: string[] = []
  const unparseable: OsvRepoResult['unparseable'] = []
  for (const file of files) {
    // A format without a parser yet is not an error: it is left out of the scan.
    if (!hasLockfileParser(file.path)) continue
    try {
      const parsed = parseLockfile(file.text, file.path, {
        ...(file.packageJson !== undefined && { packageJson: file.packageJson }),
      })
      deps.push(...parsed.map((dep) => ({ ...dep, lockfile: file.path })))
      lockfiles.push(file.path)
    } catch (error) {
      unparseable.push({ path: file.path, error: errorMessage(error) })
    }
  }
  return { all: deps, deps: dedupeDependencies(deps), lockfiles, unparseable }
}

/** Reads the lockfiles of one repo and checks them against OSV.dev. Never throws. */
export async function collectOsv(
  sources: ScanSources,
  repo: RepoRow,
  deployments: readonly DeploymentRow[],
  health: SourceOutcome<RepoHealth>,
  /** The GitHub source that reads the repo; null reads lockfiles anonymously. */
  sourceId: number | null,
): Promise<SourceOutcome<OsvRepoResult>> {
  const osv = sources.osv
  if (!osv) return { status: 'skipped', reason: 'OSV is switched off' }
  const ref = lockfileRef(
    repo,
    deployments,
    health.status === 'ok' ? health.value.defaultBranch : null,
  )
  if (!ref) return { status: 'error', error: 'branch to read lockfiles from is unknown' }
  return attempt(() => scanLockfilesAt(sources, osv, repo, ref, sourceId))
}

/**
 * Reads the lockfiles of one repo at a branch or tag and checks them against OSV.dev. Throws
 * when GitHub or OSV fails.
 */
export async function scanLockfilesAt(
  sources: Pick<ScanSources, 'fetchLockfiles'>,
  osv: OsvScanSource,
  repo: Pick<RepoRow, 'owner' | 'name'>,
  ref: string,
  /** The GitHub source that reads the repo; null reads lockfiles anonymously. */
  sourceId: number | null,
): Promise<OsvRepoResult> {
  const files = await sources.fetchLockfiles(repo.owner, repo.name, ref, sourceId)
  const { all, deps, lockfiles, unparseable } = parseAll(files)
  const matches = await scanDependencies(deps, osv.client)
  return { matches, lockfiles, unparseable, dependencies: all }
}

export interface GithubRepoScan {
  health: SourceOutcome<RepoHealth>
  alerts: SourceOutcome<DependabotAlertsResult>
  /** The GitHub source that read the repo in this scan, or null when none could. */
  sourceId: number | null
  /** What every GitHub source asked said, for repo_sources. */
  probes: SourceProbe[]
}

/**
 * Asks GitHub about one repo through its reader (see ownership.ts): health first, then its
 * Dependabot alerts. Never throws.
 */
export async function collectGithub(
  sources: ScanSources,
  repo: RepoRow,
  listed?: ReadonlyMap<number, ReadonlySet<string>>,
): Promise<GithubRepoScan> {
  if (sources.github.length === 0) {
    const skipped = { status: 'skipped', reason: 'GitHub is not connected' } as const
    return { health: skipped, alerts: skipped, sourceId: null, probes: [] }
  }
  const owner = await resolveOwnership(sources, repo, listed)
  const health: SourceOutcome<RepoHealth> = owner.health ?? {
    status: 'skipped',
    reason: 'no GitHub source sees this repo',
  }
  return {
    health,
    alerts: await collectAlerts(owner.source, repo, health),
    sourceId: owner.source?.sourceId ?? null,
    probes: owner.probes,
  }
}

/** Asks every source about one repo. Never throws: failures become `error` outcomes. */
export async function collectRepo(
  sources: ScanSources,
  repo: RepoRow,
  deployments: readonly DeploymentRow[],
): Promise<RepoScan> {
  const github = await collectGithub(sources, repo)
  const osv = await collectOsv(sources, repo, deployments, github.health, github.sourceId)
  return { repo, deployed: deployments.length > 0, ...github, osv }
}
