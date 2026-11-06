import { FINDING_TIERS, type FindingTier } from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../db/schema.js'
import { compareVersions } from '../sources/osv/semver.js'
import { tierOf } from './rank.js'
import type { RankedFinding } from './views.js'

/** One package in one repo that still needs an upgrade: the unit a fix is built from. */
export interface FixableFinding extends RankedFinding {
  repo: RepoRow
  advisory: NonNullable<RankedFinding['advisory']>
}

/**
 * Open advisory findings a version bump can clear. Left out: snoozed, accepted, fixed, fixing
 * and dismissed upstream findings, advisories the lockfile already patched, blind spots and
 * image only coverage notes (there is no package version to bump).
 */
export function isFixable(ranked: RankedFinding): ranked is FixableFinding {
  return (
    ranked.kind === 'advisory' &&
    ranked.state === 'open' &&
    !ranked.patchedInLockfile &&
    ranked.advisory !== null &&
    ranked.repo !== null
  )
}

export interface FixRepoGroup {
  repo: RepoRow
  /** Highest first patched version among this repo's findings of the package; null: no patch. */
  target: string | null
  findings: FixableFinding[]
}

/** The findings of one package that a single bump to `target` clears. */
export interface Fix {
  /** `ecosystem:package:target`, with `none` when there is no patched version. */
  key: string
  ecosystem: string
  packageName: string
  /** Highest version any repo needs, so it clears everything in the fix. Null: no patch yet. */
  target: string | null
  /** Repos need different versions. */
  mixedTargets: boolean
  /** Most urgent first. */
  findings: FixableFinding[]
  repos: FixRepoGroup[]
  apps: DeploymentRow[]
  bestTier: FindingTier
  /** A critical, runtime finding on an app reachable from the internet. */
  exposedCritical: boolean
  /** Findings in the exposed tier, used to order fixes. */
  exposedCount: number
}

export interface FixFilter {
  repo?: readonly number[]
  deployment?: readonly number[]
}

const tierIndex = (tier: FindingTier): number => FINDING_TIERS.indexOf(tier)

const SEVERITY_WEIGHT = { critical: 4, high: 3, moderate: 2, low: 1 } as const
const topSeverity = (fix: Fix): number =>
  Math.max(...fix.findings.map((f) => SEVERITY_WEIGHT[f.factors.severity]))

/** The patched version to use for a finding, or null when the advisory has none yet. */
function patchOf(finding: FixableFinding): string | null {
  const version = finding.advisory.firstPatchedVersion?.trim()
  return version ? version : null
}

function highest(versions: readonly string[]): string | null {
  let best: string | null = null
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version
  }
  return best
}

function repoGroups(findings: FixableFinding[]): FixRepoGroup[] {
  const byRepo = new Map<number, FixableFinding[]>()
  for (const finding of findings) {
    const list = byRepo.get(finding.repo.id) ?? []
    list.push(finding)
    byRepo.set(finding.repo.id, list)
  }
  return [...byRepo.values()]
    .map((list) => ({
      repo: list[0]!.repo,
      target: highest(list.flatMap((f) => patchOf(f) ?? [])),
      findings: list,
    }))
    .sort(
      (a, b) =>
        b.findings.length - a.findings.length ||
        `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`),
    )
}

function buildFix(
  ecosystem: string,
  packageName: string,
  target: string | null,
  findings: FixableFinding[],
): Fix {
  const repos = repoGroups(findings)
  const apps = new Map<number, DeploymentRow>()
  for (const finding of findings) for (const d of finding.deployments) apps.set(d.id, d)
  const tiers = findings.map(tierOf)
  return {
    key: `${ecosystem}:${packageName}:${target ?? 'none'}`,
    ecosystem,
    packageName,
    target,
    mixedTargets: target !== null && new Set(repos.map((r) => r.target)).size > 1,
    findings,
    repos,
    apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    bestTier: tiers.reduce((best, tier) => (tierIndex(tier) < tierIndex(best) ? tier : best)),
    exposedCritical: findings.some(
      (f) => tierOf(f) === 'exposed' && f.factors.severity === 'critical',
    ),
    exposedCount: tiers.filter((t) => t === 'exposed').length,
  }
}

function matchesFilter(ranked: FixableFinding, filter: FixFilter): boolean {
  return (
    (!filter.repo?.length || filter.repo.includes(ranked.repo.id)) &&
    (!filter.deployment?.length ||
      ranked.deployments.some((d) => filter.deployment!.includes(d.id)))
  )
}

/** Exposed criticals first, then the fixes that clear the most exposed findings, then the most findings, then severity. */
function compareFixes(a: Fix, b: Fix): number {
  return (
    Number(b.exposedCritical) - Number(a.exposedCritical) ||
    b.exposedCount - a.exposedCount ||
    b.findings.length - a.findings.length ||
    topSeverity(b) - topSeverity(a) ||
    tierIndex(a.bestTier) - tierIndex(b.bestTier) ||
    a.packageName.localeCompare(b.packageName) ||
    a.ecosystem.localeCompare(b.ecosystem) ||
    (a.target === null ? 1 : b.target === null ? -1 : compareVersions(a.target, b.target))
  )
}

/**
 * Groups open findings by the bump that fixes them. A fix is an ecosystem, a package and a
 * target: the highest first patched version among the grouped advisories, so one upgrade
 * clears them all, across repos. A repo that needs less than the target still shows its own
 * target and the fix is marked as `mixedTargets`. Findings with no patch yet form a separate
 * fix of the package with a null target. Pass ranked findings in rank order.
 */
export function groupFixes(ranked: readonly RankedFinding[], filter: FixFilter = {}): Fix[] {
  const byPackage = new Map<
    string,
    { ecosystem: string; packageName: string; list: FixableFinding[] }
  >()
  for (const item of ranked) {
    if (!isFixable(item) || !matchesFilter(item, filter)) continue
    const { ecosystem, packageName } = item.advisory
    const key = `${ecosystem}\n${packageName}`
    const entry = byPackage.get(key) ?? { ecosystem, packageName, list: [] }
    entry.list.push(item)
    byPackage.set(key, entry)
  }
  const fixes: Fix[] = []
  for (const { ecosystem, packageName, list } of byPackage.values()) {
    const patched = list.filter((f) => patchOf(f) !== null)
    const unpatched = list.filter((f) => patchOf(f) === null)
    if (patched.length > 0) {
      fixes.push(
        buildFix(
          ecosystem,
          packageName,
          highest(patched.flatMap((f) => patchOf(f) ?? [])),
          patched,
        ),
      )
    }
    if (unpatched.length > 0) fixes.push(buildFix(ecosystem, packageName, null, unpatched))
  }
  return fixes.sort(compareFixes)
}

/** The fix a finding belongs to, or undefined when it is not part of one. */
export function fixOf(fixes: readonly Fix[], findingId: number): Fix | undefined {
  return fixes.find((fix) => fix.findings.some((f) => f.finding.id === findingId))
}
