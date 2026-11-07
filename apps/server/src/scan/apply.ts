import type { FindingScope, Reporter } from '@hinomi/shared'
import type { FindingRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { advisoryFromGithub, advisoryFromOsv, saveAdvisory } from './advisories.js'
import type { RepoScan } from './collect.js'
import { resolveFromLockfiles } from './installed.js'
import {
  markDismissedUpstream,
  expireForNewAdvisory,
  markFixed,
  noteUpstreamDismissal,
  reopenIfDismissedUpstream,
  reopenIfFixed,
  type UpstreamDismissal,
} from './state.js'

/** A finding the scan created or changed, for notifications and the scan summary. */
export interface FindingChange {
  findingId: number
  change: 'opened' | 'reopened' | 'fixed' | 'reporters_changed' | 'expired' | 'dismissed_upstream'
}

interface Observation {
  advisoryId: number
  reporters: Set<Reporter>
  scopes: Set<FindingScope>
  manifestPaths: Set<string>
  installedVersion: string | undefined
  /**
   * Every GitHub alert for it resolves to patched versions in the lockfile. Undefined when
   * GitHub did not report it; an OSV match sets it to false, since OSV checked the lockfile.
   */
  patchedInLockfile: boolean | undefined
  /** Shortest chain any lockfile showed, runtime ones first. */
  dependencyPath: string[] | undefined
  pathIsRuntime: boolean
}

/**
 * Runtime wins over unknown, unknown over dev: when one package is pulled in
 * by several manifests the finding takes the most exposed scope.
 */
export function mergeScopes(scopes: Iterable<FindingScope>): FindingScope {
  const all = new Set(scopes)
  if (all.has('runtime')) return 'runtime'
  if (all.has('unknown') || all.size === 0) return 'unknown'
  return 'dev'
}

/** Sources that fully covered the repo this scan: what they did not report is gone. */
export function coveringSources(scan: RepoScan): Set<Reporter> {
  const covered = new Set<Reporter>()
  if (scan.alerts.status === 'ok') covered.add('github')
  if (
    scan.osv.status === 'ok' &&
    scan.osv.value.lockfiles.length > 0 &&
    scan.osv.value.unparseable.length === 0
  ) {
    covered.add('osv')
  }
  return covered
}

/**
 * Reporters a finding keeps after a scan: the ones that reported it now, plus
 * earlier ones that could not look this time (errored, skipped or partial).
 * An empty result means every source that knew about it looked and it is gone.
 */
export function remainingReporters(
  previous: readonly Reporter[],
  current: ReadonlySet<Reporter>,
  covered: ReadonlySet<Reporter>,
): Reporter[] {
  const kept = previous.filter((r) => !covered.has(r))
  return [...new Set([...current, ...kept])].sort()
}

function observationFor(map: Map<number, Observation>, advisoryId: number): Observation {
  let obs = map.get(advisoryId)
  if (!obs) {
    obs = {
      advisoryId,
      reporters: new Set(),
      scopes: new Set(),
      manifestPaths: new Set(),
      installedVersion: undefined,
      patchedInLockfile: undefined,
      dependencyPath: undefined,
      pathIsRuntime: false,
    }
    map.set(advisoryId, obs)
  }
  return obs
}

/** Keeps the path that best explains the finding: runtime over dev, then the shortest. */
function notePath(obs: Observation, path: string[] | undefined, runtime: boolean): void {
  if (!path || path.length === 0) return
  const better =
    obs.dependencyPath === undefined ||
    (runtime && !obs.pathIsRuntime) ||
    (runtime === obs.pathIsRuntime && path.length < obs.dependencyPath.length)
  if (!better) return
  obs.dependencyPath = path
  obs.pathIsRuntime = runtime
}

function collectObservations(repositories: Repositories, scan: RepoScan) {
  const map = new Map<number, Observation>()
  if (scan.alerts.status === 'ok') {
    const { advisories, alerts } = scan.alerts.value
    const byKey = new Map(advisories.map((a) => [`${a.ghsaId}|${a.ecosystem}|${a.package}`, a]))
    const deps = scan.osv.status === 'ok' ? (scan.osv.value.dependencies ?? []) : []
    for (const alert of alerts) {
      if (alert.dismissedAt !== null) continue
      const record = byKey.get(`${alert.ghsaId}|${alert.ecosystem}|${alert.package}`)
      if (!record) continue
      const advisory = saveAdvisory(repositories.advisories, advisoryFromGithub(record), 'github')
      const obs = observationFor(map, advisory.id)
      obs.reporters.add('github')
      obs.scopes.add(alert.scope ?? 'unknown')
      if (alert.manifestPath) obs.manifestPaths.add(alert.manifestPath)
      // An OSV match below sets the exact version; this covers alerts OSV did not match.
      const found = resolveFromLockfiles(deps, alert, record.vulnerableRange, record.firstPatched)
      if (
        obs.installedVersion === undefined ||
        (obs.patchedInLockfile === true && !found.patched && found.installed !== undefined)
      ) {
        obs.installedVersion = found.installed ?? obs.installedVersion
      }
      obs.patchedInLockfile = (obs.patchedInLockfile ?? true) && found.patched
    }
  }
  if (scan.osv.status === 'ok') {
    for (const match of scan.osv.value.matches) {
      const advisory = saveAdvisory(repositories.advisories, advisoryFromOsv(match), 'osv')
      const obs = observationFor(map, advisory.id)
      obs.reporters.add('osv')
      obs.scopes.add(match.scope)
      obs.installedVersion = match.installedVersion
      obs.patchedInLockfile = false
      if (match.lockfile) obs.manifestPaths.add(match.lockfile)
      notePath(obs, match.path, match.scope === 'runtime')
    }
  }
  return map
}

/** An advisory GitHub reports as dismissed on this repo and does not report as open. */
interface Dismissal extends UpstreamDismissal {
  advisoryId: number
  scope: FindingScope
  manifestPaths: string[]
}

function upstreamOf(d: Dismissal): UpstreamDismissal {
  return {
    reason: d.reason,
    comment: d.comment,
    dismissedAt: d.dismissedAt,
    alertNumbers: d.alertNumbers,
  }
}

/** The latest dismissal per advisory, left out when GitHub also has an open alert for it. */
function collectDismissals(
  repositories: Repositories,
  scan: RepoScan,
  observations: ReadonlyMap<number, Observation>,
): Dismissal[] {
  if (scan.alerts.status !== 'ok') return []
  const { advisories, dismissed } = scan.alerts.value
  const byKey = new Map(advisories.map((a) => [`${a.ghsaId}|${a.ecosystem}|${a.package}`, a]))
  const byAdvisory = new Map<number, Dismissal>()
  for (const alert of dismissed) {
    const record = byKey.get(`${alert.ghsaId}|${alert.ecosystem}|${alert.package}`)
    if (!record) continue
    const advisory = saveAdvisory(repositories.advisories, advisoryFromGithub(record), 'github')
    if (observations.get(advisory.id)?.reporters.has('github')) continue
    const known = byAdvisory.get(advisory.id)
    if (!known) {
      byAdvisory.set(advisory.id, {
        advisoryId: advisory.id,
        scope: alert.scope ?? 'unknown',
        manifestPaths: alert.manifestPath ? [alert.manifestPath] : [],
        reason: alert.dismissReason,
        comment: alert.dismissComment,
        dismissedAt: alert.dismissedAt,
        alertNumbers: [alert.alertNumber],
      })
      continue
    }
    known.alertNumbers.push(alert.alertNumber)
    if (alert.manifestPath) known.manifestPaths.push(alert.manifestPath)
    if (alert.dismissedAt > known.dismissedAt) {
      known.dismissedAt = alert.dismissedAt
      known.reason = alert.dismissReason
      known.comment = alert.dismissComment
    }
  }
  return [...byAdvisory.values()]
}

function sameReporters(a: readonly Reporter[], b: readonly Reporter[]): boolean {
  const set = new Set(a)
  return a.length === b.length && b.every((r) => set.has(r))
}

function applyObservation(
  repositories: Repositories,
  repoId: number,
  obs: Observation,
  covered: ReadonlySet<Reporter>,
  now: Date,
  changes: FindingChange[],
): number {
  const { findings } = repositories
  const { finding, created } = findings.observe(
    {
      kind: 'advisory',
      advisoryId: obs.advisoryId,
      repoId,
      scope: mergeScopes(obs.scopes),
      reportedBy: [...obs.reporters],
      manifestPaths: [...obs.manifestPaths],
      ...(obs.installedVersion !== undefined && { installedVersion: obs.installedVersion }),
      ...(obs.patchedInLockfile !== undefined && { patchedInLockfile: obs.patchedInLockfile }),
      ...(obs.dependencyPath !== undefined && { dependencyPath: obs.dependencyPath }),
    },
    now,
  )
  if (created) {
    changes.push({ findingId: finding.id, change: 'opened' })
    const advisoryOf = (id: number) => repositories.advisories.get(id)
    for (const reopened of expireForNewAdvisory(findings, advisoryOf, finding, now)) {
      changes.push({ findingId: reopened.id, change: 'expired' })
    }
    return finding.id
  }
  const before = finding.reportedBy
  const reporters = remainingReporters(before, obs.reporters, covered)
  if (!sameReporters(before, reporters)) findings.setReportedBy(finding.id, reporters)
  if (reopenIfFixed(findings, finding, now)) {
    changes.push({ findingId: finding.id, change: 'reopened' })
  } else if (
    reopenIfDismissedUpstream(
      findings,
      finding,
      now,
      obs.reporters.has('github') ? 'reopened_upstream' : 'still_reported',
    )
  ) {
    changes.push({ findingId: finding.id, change: 'reopened' })
  }
  return finding.id
}

/**
 * GitHub dismissed this advisory. Another source that still reports it keeps
 * it open (with a note); otherwise it becomes `dismissed_upstream`, never
 * `fixed`. A source that could not look this time still counts as a reporter.
 */
function applyDismissal(
  repositories: Repositories,
  repoId: number,
  dismissal: Dismissal,
  observed: Observation | undefined,
  covered: ReadonlySet<Reporter>,
  now: Date,
  changes: FindingChange[],
): number {
  const { findings } = repositories
  const { finding } = findings.observe(
    {
      kind: 'advisory',
      advisoryId: dismissal.advisoryId,
      repoId,
      scope: observed ? mergeScopes(observed.scopes) : dismissal.scope,
      reportedBy: observed ? [...observed.reporters] : ['github'],
      manifestPaths: dismissal.manifestPaths,
    },
    now,
  )
  const stillReported =
    observed !== undefined ||
    remainingReporters(finding.reportedBy, new Set(), covered).some((r) => r !== 'github')
  if (stillReported) {
    noteUpstreamDismissal(findings, finding, now, upstreamOf(dismissal))
    return finding.id
  }
  findings.setReportedBy(finding.id, ['github'])
  if (markDismissedUpstream(findings, finding, now, upstreamOf(dismissal))) {
    changes.push({ findingId: finding.id, change: 'dismissed_upstream' })
  }
  return finding.id
}

/** An advisory finding no source reported this scan. Fixed when nobody can still vouch for it. */
function applyMissing(
  repositories: Repositories,
  finding: FindingRow,
  covered: ReadonlySet<Reporter>,
  now: Date,
  changes: FindingChange[],
): void {
  const reporters = remainingReporters(finding.reportedBy, new Set(), covered)
  if (reporters.length === 0) {
    if (markFixed(repositories.findings, finding, now, { coveredBy: [...covered].sort() })) {
      changes.push({ findingId: finding.id, change: 'fixed' })
    }
    return
  }
  if (sameReporters(finding.reportedBy, reporters)) return
  repositories.findings.setReportedBy(finding.id, reporters)
  repositories.findings.addEvent({
    findingId: finding.id,
    type: 'reporters_changed',
    actor: 'system',
    data: { from: finding.reportedBy, to: reporters },
    at: now,
  })
  changes.push({ findingId: finding.id, change: 'reporters_changed' })
}

/**
 * Writes one repo's advisory results: upserts advisories (deduped across
 * sources), observes findings, reopens fixed ones that came back and fixes
 * the ones every covering source stopped reporting. A repo that no source
 * covered (all errored or skipped) keeps its findings untouched.
 */
export function applyRepoAdvisories(
  repositories: Repositories,
  scan: RepoScan,
  now: Date,
): FindingChange[] {
  return repositories.db.transaction(() => {
    const changes: FindingChange[] = []
    const covered = coveringSources(scan)
    const seen = new Set<number>()
    const observations = collectObservations(repositories, scan)
    for (const obs of observations.values()) {
      seen.add(applyObservation(repositories, scan.repo.id, obs, covered, now, changes))
    }
    for (const dismissal of collectDismissals(repositories, scan, observations)) {
      const observed = observations.get(dismissal.advisoryId)
      seen.add(
        applyDismissal(repositories, scan.repo.id, dismissal, observed, covered, now, changes),
      )
    }
    if (covered.size === 0) return changes
    const existing = repositories.findings.list({ repoId: scan.repo.id, kind: 'advisory' })
    for (const finding of existing) {
      if (seen.has(finding.id) || finding.state === 'fixed') continue
      applyMissing(repositories, finding, covered, now, changes)
    }
    return changes
  })
}
