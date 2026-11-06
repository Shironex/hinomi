import type { LockfileDependency } from '@hinomi/shared'
import { compareVersions } from '../sources/osv/semver.js'
import { normalizeEcosystem } from './advisories.js'

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

/**
 * True when `version` satisfies a GitHub style range such as
 * `>= 1.0.0, < 1.2.3` or `= 4.17.20`. A part Hinomi cannot read counts as
 * satisfied, so an odd range never hides a version.
 */
export function inGithubRange(version: string, range: string): boolean {
  return range.split(',').every((part) => {
    const match = /^\s*(<=|>=|<|>|=)?\s*v?(\S+)\s*$/.exec(part)
    if (!match) return true
    const cmp = compareVersions(version, match[2]!)
    switch (match[1]) {
      case '<':
        return cmp < 0
      case '<=':
        return cmp <= 0
      case '>':
        return cmp > 0
      case '>=':
        return cmp >= 0
      default:
        return cmp === 0
    }
  })
}

/**
 * The installed version of a package a GitHub alert names, read from the
 * repo's parsed lockfiles. GitHub alerts carry no version, and before this
 * only an OSV match on the same advisory filled one in, so an alert OSV did
 * not match (advisory not in OSV yet, a range the two disagree on) showed no
 * version even with the lockfile right there.
 *
 * Lockfiles are tried closest first: the alert's manifest itself, then any
 * in the same folder, then all of them. Several versions are narrowed to the
 * ones inside the vulnerable range; what is left is joined with a comma.
 * Undefined when no lockfile lists the package.
 */
export function installedFromLockfiles(
  deps: readonly LockfileDependency[],
  alert: { package: string; ecosystem: string; manifestPath: string | null },
  vulnerableRange: string | null,
): string | undefined {
  const named = deps.filter(
    (d) => d.name === alert.package && normalizeEcosystem(d.ecosystem) === alert.ecosystem,
  )
  const manifest = alert.manifestPath
  const tiers = [
    manifest ? named.filter((d) => d.lockfile === manifest) : [],
    manifest ? named.filter((d) => d.lockfile && dirOf(d.lockfile) === dirOf(manifest)) : [],
    named,
  ]
  const found = tiers.find((t) => t.length > 0)
  if (!found) return undefined
  const versions = [...new Set(found.map((d) => d.version))].sort(compareVersions)
  const vulnerable = vulnerableRange
    ? versions.filter((v) => inGithubRange(v, vulnerableRange))
    : versions
  return (vulnerable.length > 0 ? vulnerable : versions).join(', ')
}
