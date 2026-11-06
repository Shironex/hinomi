import type { FindingScope, Reporter } from '@hinomi/shared'
import type { FindingRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { advisoryFromGithub, advisoryFromOsv, saveAdvisory } from './advisories.js'
import type { RepoScan } from './collect.js'
import { markFixed, reopenIfFixed } from './state.js'

/** A finding the scan created or changed, for notifications (#11) and the scan summary. */
export interface FindingChange {
  findingId: number
  change: 'opened' | 'reopened' | 'fixed' | 'reporters_changed' | 'expired'
}

interface Observation {
  advisoryId: number
  reporters: Set<Reporter>
  scopes: Set<FindingScope>
  manifestPaths: Set<string>
  installedVersion: string | undefined
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
    }
    map.set(advisoryId, obs)
  }
  return obs
}

function collectObservations(repositories: Repositories, scan: RepoScan) {
  const map = new Map<number, Observation>()
  if (scan.alerts.status === 'ok') {
    const { advisories, alerts } = scan.alerts.value
    const byKey = new Map(advisories.map((a) => [`${a.ghsaId}|${a.ecosystem}|${a.package}`, a]))
    for (const alert of alerts) {
      if (alert.dismissedAt !== null) continue
      const record = byKey.get(`${alert.ghsaId}|${alert.ecosystem}|${alert.package}`)
      if (!record) continue
      const advisory = saveAdvisory(repositories.advisories, advisoryFromGithub(record), 'github')
      const obs = observationFor(map, advisory.id)
      obs.reporters.add('github')
      obs.scopes.add(alert.scope ?? 'unknown')
      if (alert.manifestPath) obs.manifestPaths.add(alert.manifestPath)
    }
  }
  if (scan.osv.status === 'ok') {
    for (const match of scan.osv.value.matches) {
      const advisory = saveAdvisory(repositories.advisories, advisoryFromOsv(match), 'osv')
      const obs = observationFor(map, advisory.id)
      obs.reporters.add('osv')
      obs.scopes.add(match.scope)
      obs.installedVersion = match.installedVersion
    }
  }
  return map
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
    },
    now,
  )
  if (created) {
    changes.push({ findingId: finding.id, change: 'opened' })
    return finding.id
  }
  const before = finding.reportedBy
  const reporters = remainingReporters(before, obs.reporters, covered)
  if (!sameReporters(before, reporters)) findings.setReportedBy(finding.id, reporters)
  if (reopenIfFixed(findings, finding, now)) {
    changes.push({ findingId: finding.id, change: 'reopened' })
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
  if (!sameReporters(finding.reportedBy, reporters)) {
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
    for (const obs of collectObservations(repositories, scan).values()) {
      seen.add(applyObservation(repositories, scan.repo.id, obs, covered, now, changes))
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
