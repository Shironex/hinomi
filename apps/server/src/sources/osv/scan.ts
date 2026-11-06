import type { LockfileDependency, OsvAdvisoryMatch, OsvVulnerability } from '@hinomi/shared'
import { createOsvClient, type OsvClient } from './client.js'
import { parseLockfile, type ParseLockfileOptions } from './lockfiles/index.js'
import { compareVersions, formatRange, matchRange, type RangeHit } from './semver.js'
import { deriveSeverity } from './severity.js'

export interface ScanOptions extends ParseLockfileOptions {
  /** Defaults to a fresh client against api.osv.dev. Pass one to share its cache. */
  client?: OsvClient
}

interface AffectedHit {
  ranges: RangeHit[]
  /** Every fixed event of the package's ranges, to pick the first patch above the installed version. */
  fixes: string[]
  explicit: boolean
}

/**
 * Checks the vulnerability's `affected` entries for this package and version
 * locally, so a record that OSV returned but that does not cover the installed
 * version (stale index, ecosystem quirks) never becomes a finding.
 */
function affectedHit(vuln: OsvVulnerability, dep: LockfileDependency): AffectedHit | null {
  const result: AffectedHit = { ranges: [], fixes: [], explicit: false }
  let considered = false
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== dep.name || affected.package.ecosystem !== dep.ecosystem)
      continue
    considered = true
    if (affected.versions?.includes(dep.version)) result.explicit = true
    for (const range of affected.ranges ?? []) {
      for (const e of range.events) if (e.fixed) result.fixes.push(e.fixed)
      const hit = matchRange(range, dep.version)
      if (hit) result.ranges.push(hit)
    }
  }
  if (!considered) return null
  return result.explicit || result.ranges.length > 0 ? result : null
}

function toMatch(
  vuln: OsvVulnerability,
  dep: LockfileDependency,
  hit: AffectedHit,
): OsvAdvisoryMatch {
  const ids = [vuln.id, ...(vuln.aliases ?? [])]
  const firstPatched =
    hit.fixes.filter((v) => compareVersions(v, dep.version) > 0).sort(compareVersions)[0] ?? null
  const range = hit.ranges[0]
  return {
    source: 'osv',
    osvId: vuln.id,
    ghsaId: ids.find((id) => id.startsWith('GHSA-')) ?? null,
    cveIds: [...new Set(ids.filter((id) => id.startsWith('CVE-')))],
    aliases: vuln.aliases ?? [],
    package: dep.name,
    ecosystem: dep.ecosystem,
    ...deriveSeverity(vuln),
    summary: vuln.summary ?? null,
    vulnerableRange: range ? formatRange(range) : null,
    firstPatched,
    publishedAt: vuln.published ?? null,
    modifiedAt: vuln.modified ?? null,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
    installedVersion: dep.version,
    scope: dep.scope,
    direct: dep.direct,
  }
}

/** One finding per advisory and installed package; prefers the GHSA record among aliases. */
function dedupeKey(m: OsvAdvisoryMatch): string {
  return `${m.ghsaId ?? m.cveIds[0] ?? m.osvId}\u0000${m.ecosystem}\u0000${m.package}\u0000${m.installedVersion}`
}

/** Queries OSV for already parsed dependencies and returns normalised matches. */
export async function scanDependencies(
  deps: LockfileDependency[],
  client: OsvClient = createOsvClient(),
): Promise<OsvAdvisoryMatch[]> {
  if (deps.length === 0) return []
  const idLists = await client.queryBatch(
    deps.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
  )
  const uniqueIds = [...new Set(idLists.flat())]
  const vulns = new Map<string, OsvVulnerability>()
  const details = await client.getVulnerabilities(uniqueIds)
  uniqueIds.forEach((id, i) => vulns.set(id, details[i]!))

  const out = new Map<string, OsvAdvisoryMatch>()
  deps.forEach((dep, i) => {
    for (const id of idLists[i] ?? []) {
      const vuln = vulns.get(id)
      if (!vuln || vuln.withdrawn) continue
      const hit = affectedHit(vuln, dep)
      if (!hit) continue
      const match = toMatch(vuln, dep, hit)
      const key = dedupeKey(match)
      const prev = out.get(key)
      if (!prev || (!prev.osvId.startsWith('GHSA-') && match.osvId.startsWith('GHSA-'))) {
        out.set(key, match)
      }
    }
  })
  return [...out.values()]
}

/**
 * Parses a lockfile and matches its packages against OSV.
 * `filename` picks the parser (`pnpm-lock.yaml`, `apps/web/yarn.lock`, ...).
 */
export async function scanLockfile(
  text: string,
  filename: string,
  options: ScanOptions = {},
): Promise<OsvAdvisoryMatch[]> {
  const deps = parseLockfile(text, filename, options)
  return scanDependencies(deps, options.client)
}
