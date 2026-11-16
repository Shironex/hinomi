import {
  archivedDeployedEvidenceSchema,
  SOURCE_KINDS,
  type ArchivedDeployedEvidence,
  type ArchivedRepoEntry,
  type GuardEvidence,
} from '@hinomi/shared'
import { GITHUB_NOT_CONNECTED, type RepoScan } from '../collect.js'
import { reposByDeployment } from '../deployments.js'
import { repoKey } from '../ownership.js'
import { worstResult } from './runtime-lines.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// archived_deployed (a repo blind spot until it became a guard check): does a deployment run code
// from a GitHub repo that is archived? Reads the repo health the alerts phase already fetched (the
// archived flag of GET /repos/{owner}/{repo}), so the check costs no GitHub call of its own.
// GitHub follows a renamed repo to its new name; the evidence says so.

const NOT_SEEN =
  'No connected GitHub source sees this repo: it was deleted, moved to an account the token cannot read, or is hosted elsewhere.'
const NO_REPO = 'This deployment runs no mapped repo, so no archived repo is deployed.'
const ACCESS_LOST =
  'The GitHub token or app lost access to this repo (sign in or permission refused), so nothing can tell whether it is archived.'

/** Errors that say access is gone, not that GitHub is briefly unavailable. */
const ACCESS_ERRORS: ReadonlySet<string> = new Set(['auth', 'permission'])

/**
 * What this scan says about one repo: an entry, or null when it could not tell this time (a rate
 * limit, a network error, a server error), which leaves the deployment's finding alone. A 404
 * from every source, or a refused sign in or permission, is `unknown`: it would not pass by
 * itself on the next scan.
 */
export function archivedEntry(scan: RepoScan): ArchivedRepoEntry | null {
  const { repo, health } = scan
  const base = { repoId: repo.id, repo: `${repo.owner}/${repo.name}` }
  const unknown = (reason: string): ArchivedRepoEntry => ({
    ...base,
    renamedTo: null,
    archived: null,
    pushedAt: null,
    result: 'unknown',
    reason,
    turnedOff: false,
  })
  if (health.status === 'skipped') {
    // collectGithub skips when GitHub is not connected, or when no source's account list has it.
    return unknown(
      health.reason === GITHUB_NOT_CONNECTED
        ? 'GitHub is not connected, so nothing can tell whether the repo is archived.'
        : NOT_SEEN,
    )
  }
  if (health.status === 'error') {
    const probes = scan.probes ?? []
    const lost = (p: (typeof probes)[number]) =>
      p.sees === null && p.errorKind !== undefined && ACCESS_ERRORS.has(p.errorKind)
    if (probes.length === 0 || !probes.every((p) => p.sees === false || lost(p))) return null
    return unknown(probes.some(lost) ? ACCESS_LOST : NOT_SEEN)
  }
  const { value } = health
  const answered = repoKey(value.owner, value.name)
  return {
    ...base,
    renamedTo: answered === repoKey(repo.owner, repo.name) ? null : `${value.owner}/${value.name}`,
    archived: value.archived,
    pushedAt: value.pushedAt,
    result: value.archived ? 'fail' : 'pass',
    reason: null,
    turnedOff: false,
  }
}

/** Why evidence at the same level is worse news, for the escalation event. */
export interface Worsening {
  reason: string
  data: Record<string, unknown>
}

/** Repo ids a stored archived_deployed evidence counted as failing (turned off ones left out). */
function failingRepoIds(stored: unknown): Set<number> {
  const parsed = archivedDeployedEvidenceSchema.safeParse(stored)
  if (!parsed.success) return new Set()
  return new Set(
    parsed.data.repos.filter((r) => r.result === 'fail' && !r.turnedOff).map((r) => r.repoId),
  )
}

/**
 * A repo of the deployment counts as archived now that did not before, at the same `fail` level:
 * that is worse news (a snooze set for the first repo must not hide it), so it escalates.
 */
export function newlyArchivedRepos(before: unknown, after: GuardEvidence): Worsening | null {
  if (after.check !== 'archived_deployed') return null
  const was = failingRepoIds(before)
  const fresh = after.repos.filter((r) => r.result === 'fail' && !r.turnedOff && !was.has(r.repoId))
  if (fresh.length === 0) return null
  const names = fresh.map((r) => r.renamedTo ?? r.repo)
  return { reason: `newly archived: ${names.join(', ')}`, data: { repos: names } }
}

function evidence(repos: ArchivedRepoEntry[], reason: string | null): ArchivedDeployedEvidence {
  return { check: 'archived_deployed', repos, reason }
}

export function evaluateArchivedDeployed(ctx: GuardContext): GuardSubjectResult[] {
  const repoIds = reposByDeployment(ctx.index)
  const results: GuardSubjectResult[] = []
  for (const deployment of ctx.deployments) {
    const subject = { deploymentId: deployment.id }
    const ids = repoIds.get(deployment.id) ?? []
    if (ids.length === 0) {
      // Resolves a finding left from a mapping that is gone; no_repo_mapping covers the gap.
      results.push({ subject, level: 'pass', evidence: evidence([], NO_REPO) })
      continue
    }
    const entries: ArchivedRepoEntry[] = []
    let undecided = false
    for (const id of ids) {
      // An override on this repo turns off its entry only, never the deployment's other repos.
      const turnedOff = ctx.overrides?.covering('archived_deployed', { repoId: id }) != null
      const scan = ctx.scans.get(id)
      const entry = scan ? archivedEntry(scan) : null
      if (entry) entries.push({ ...entry, turnedOff })
      else if (!turnedOff) undecided = true
    }
    // The level comes from the repos still checked; when every repo is turned off it is theirs,
    // and the override covering the deployment accepts the finding.
    const active = entries.filter((e) => !e.turnedOff)
    const judged = active.length > 0 || entries.length === 0 ? active : entries
    const level = worstResult(judged.map((e) => e.result))
    // A repo GitHub could not answer for this time only matters while nothing else fails.
    if (undecided && level !== 'fail') {
      results.push({ subject, level: null })
      continue
    }
    if (level === 'pass') {
      results.push({ subject, level, evidence: evidence(entries, null) })
      continue
    }
    const reason =
      level === 'unknown' ? (judged.find((e) => e.result === 'unknown')?.reason ?? null) : null
    results.push({ subject, level, evidence: evidence(entries, reason) })
  }
  return results
}

export const archivedDeployedGuard: Guard = {
  check: 'archived_deployed',
  // The answer comes from GitHub, so every deployment source can be checked the same way.
  capabilities: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 'full' as const])),
  run: evaluateArchivedDeployed,
}
