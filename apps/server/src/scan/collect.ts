import type {
  DependabotAlertsResult,
  LockfileDependency,
  OsvAdvisoryMatch,
  RepoHealth,
} from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../db/schema.js'
import { dedupeDependencies, parseLockfile, scanDependencies } from '../sources/osv/index.js'
import { lockfileRef } from './deployments.js'
import type { ScanSources } from './sources.js'

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
}

export interface RepoScan {
  repo: RepoRow
  deployed: boolean
  health: SourceOutcome<RepoHealth>
  alerts: SourceOutcome<DependabotAlertsResult>
  osv: SourceOutcome<OsvRepoResult>
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
  sources: ScanSources,
  repo: RepoRow,
  health: SourceOutcome<RepoHealth>,
): Promise<SourceOutcome<DependabotAlertsResult>> {
  const github = sources.github
  if (!github) return { status: 'skipped', reason: 'GitHub is not connected' }
  if (health.status !== 'ok') return { status: 'skipped', reason: 'repo health unavailable' }
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
  return { deps: dedupeDependencies(deps), lockfiles, unparseable }
}

/** Reads the lockfiles of one repo and checks them against OSV.dev. Never throws. */
export async function collectOsv(
  sources: ScanSources,
  repo: RepoRow,
  deployments: readonly DeploymentRow[],
  health: SourceOutcome<RepoHealth>,
): Promise<SourceOutcome<OsvRepoResult>> {
  const osv = sources.osv
  if (!osv) return { status: 'skipped', reason: 'OSV is switched off' }
  const ref = lockfileRef(
    repo,
    deployments,
    health.status === 'ok' ? health.value.defaultBranch : null,
  )
  if (!ref) return { status: 'error', error: 'branch to read lockfiles from is unknown' }
  return attempt(async () => {
    const files = await sources.fetchLockfiles(repo.owner, repo.name, ref)
    const { deps, lockfiles, unparseable } = parseAll(files)
    const matches = await scanDependencies(deps, osv.client)
    return { matches, lockfiles, unparseable }
  })
}

export interface GithubRepoScan {
  health: SourceOutcome<RepoHealth>
  alerts: SourceOutcome<DependabotAlertsResult>
}

/** Asks GitHub about one repo: health first, then its Dependabot alerts. Never throws. */
export async function collectGithub(sources: ScanSources, repo: RepoRow): Promise<GithubRepoScan> {
  const github = sources.github
  const health: SourceOutcome<RepoHealth> = github
    ? await attempt(() => github.fetchRepoHealth(repo.owner, repo.name))
    : { status: 'skipped', reason: 'GitHub is not connected' }
  return { health, alerts: await collectAlerts(sources, repo, health) }
}

/** Asks every source about one repo. Never throws: failures become `error` outcomes. */
export async function collectRepo(
  sources: ScanSources,
  repo: RepoRow,
  deployments: readonly DeploymentRow[],
): Promise<RepoScan> {
  const { health, alerts } = await collectGithub(sources, repo)
  const osv = await collectOsv(sources, repo, deployments, health)
  return { repo, deployed: deployments.length > 0, health, alerts, osv }
}
