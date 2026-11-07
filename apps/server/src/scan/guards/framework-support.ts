import {
  SOURCE_KINDS,
  type FrameworkEntry,
  type FrameworkSupportEvidence,
  type GuardResult,
  type LockfileDependency,
  type OsvEcosystem,
  type SupportLine,
  type SupportTarget,
} from '@hinomi/shared'
import {
  daysUntilEol,
  isPastEol,
  supportBasisOf,
  windowStateOf,
  type SupportIndex,
  type SupportProduct,
  type SupportRelease,
} from '../../support/index.js'
import { lockfileRef } from '../deployments.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// framework_support (docs/design/phase-2.md section 4.5): a direct runtime dependency that
// endoflife.date knows as a product (joined by purl, no hand kept list) on a release line that
// lost, or is about to lose, security support. One finding per repo, listing every match.

/** The purl type of each ecosystem the lockfile readers produce. */
const PURL_TYPES: Record<OsvEcosystem, string> = {
  npm: 'npm',
  'crates.io': 'cargo',
  Go: 'golang',
  PyPI: 'pypi',
  Packagist: 'composer',
  RubyGems: 'gem',
}

/** Worst last. */
const RESULT_ORDER: Record<GuardResult, number> = { pass: 0, unknown: 1, warn: 2, fail: 3 }

const RELEASE_CYCLE_NOTE =
  'Some of these products publish no security support dates, so their end dates come from the release cycle. Those lines warn at most and never fail.'
const UNKNOWN_NOTE =
  'The installed version matches no release line in the support data (a typo, or a line newer than the cached copy).'

/**
 * Direct dependencies that ship with the app, one per package and version. Dev dependencies and
 * transitive ones never count. A scope the lockfile cannot tell (Cargo, yarn without a
 * package.json) is kept: it is not known to be dev only.
 */
export function directRuntimeDependencies(
  dependencies: readonly LockfileDependency[],
): LockfileDependency[] {
  const unique = new Map<string, LockfileDependency>()
  for (const dep of dependencies) {
    if (!dep.direct || dep.scope === 'dev') continue
    const key = `${dep.ecosystem}\u0000${dep.name}\u0000${dep.version}`
    if (!unique.has(key)) unique.set(key, dep)
  }
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

/** The package.json of the workspace that lists an npm package, when the lockfile says which. */
function manifestPathOf(dep: LockfileDependency): string | null {
  const workspace = dep.workspaces?.[0]
  if (dep.ecosystem !== 'npm' || workspace === undefined || dep.lockfile === undefined) return null
  const folder = dep.lockfile.includes('/')
    ? dep.lockfile.slice(0, dep.lockfile.lastIndexOf('/'))
    : ''
  const parts = [folder, workspace === '.' ? '' : workspace, 'package.json']
  return parts.filter((part) => part !== '').join('/')
}

/** The newest line that still gets support: where an upgrade should go. */
function targetOf(product: SupportProduct, now: Date, windowDays: number): SupportTarget | null {
  for (const release of product.releases) {
    const state = windowStateOf(release, now, windowDays)
    if (state === 'supported' || state === 'maintenance') {
      return { line: release.name, latest: release.latest?.name ?? null }
    }
  }
  return null
}

function supportLineOf(product: SupportProduct, release: SupportRelease, now: Date): SupportLine {
  return {
    product: product.name,
    line: release.name,
    eolFrom: release.eolFrom,
    isEol: isPastEol(release, now),
    isEoas: release.isEoas,
    latest: release.latest?.name ?? null,
    basis: supportBasisOf(product),
    daysLeft: daysUntilEol(release, now),
  }
}

function entryFor(
  index: SupportIndex,
  dep: LockfileDependency,
  product: SupportProduct,
  purl: string,
  now: Date,
  windowDays: number,
): { entry: FrameworkEntry; capped: boolean } {
  const base = {
    packageName: dep.name,
    ecosystem: dep.ecosystem,
    purl,
    installedVersion: dep.version,
    manifestPath: manifestPathOf(dep),
  }
  const release = index.line(product.name, dep.version)
  if (!release) {
    return { entry: { ...base, result: 'unknown', support: null, target: null }, capped: false }
  }
  const support = supportLineOf(product, release, now)
  const state = windowStateOf(release, now, windowDays)
  // `maintenance` (bug fixes over, security fixes continue) is shown by the dates, never a level.
  let result: GuardResult = state === 'eol' ? 'fail' : state === 'ending' ? 'warn' : 'pass'
  // Without security dates a line's end is only the day its successor shipped: that is not proof
  // that fixes stopped, so it can warn but never fail.
  const capped = result === 'fail' && support.basis === 'release_cycle'
  if (capped) result = 'warn'
  const target = result === 'pass' ? null : targetOf(product, now, windowDays)
  return { entry: { ...base, result, support, target }, capped }
}

/** Every matched framework of one repo's direct runtime dependencies. */
export function frameworkEntries(
  index: SupportIndex,
  dependencies: readonly LockfileDependency[],
  now: Date,
  windowDays: number,
): { entries: FrameworkEntry[]; capped: boolean } {
  const entries: FrameworkEntry[] = []
  let capped = false
  for (const dep of directRuntimeDependencies(dependencies)) {
    const purl = `pkg:${PURL_TYPES[dep.ecosystem]}/${dep.name.toLowerCase()}`
    for (const product of index.productsForPurl(purl)) {
      const made = entryFor(index, dep, product, purl, now, windowDays)
      entries.push(made.entry)
      capped ||= made.capped
    }
  }
  return { entries, capped }
}

function evaluateRepo(ctx: GuardContext, index: SupportIndex): GuardSubjectResult[] {
  const results: GuardSubjectResult[] = []
  for (const repo of ctx.repos) {
    const scan = ctx.scans.get(repo.id)
    // Lockfiles that were not read (OSV off, fetch failed) say nothing: leave the row alone.
    if (!scan || scan.osv.status !== 'ok') continue
    const subject = { repoId: repo.id }
    const { entries, capped } = frameworkEntries(
      index,
      scan.osv.value.dependencies ?? [],
      ctx.now,
      ctx.supportWindowDays,
    )
    if (entries.length === 0) {
      results.push({ subject, level: 'pass' })
      continue
    }
    const worst = entries.reduce<GuardResult>(
      (acc, e) => (RESULT_ORDER[e.result] > RESULT_ORDER[acc] ? e.result : acc),
      'pass',
    )
    const notes = [
      entries.some((e) => e.result === 'unknown') ? UNKNOWN_NOTE : null,
      capped ? RELEASE_CYCLE_NOTE : null,
    ].filter((note) => note !== null)
    const deployments = ctx.index.byRepo.get(repo.id) ?? []
    const evidence: FrameworkSupportEvidence = {
      check: 'framework_support',
      ref: lockfileRef(
        repo,
        deployments,
        scan.health.status === 'ok' ? scan.health.value.defaultBranch : null,
      ),
      frameworks: entries,
      reason: notes.length > 0 ? notes.join(' ') : null,
    }
    results.push(
      worst === 'pass' ? { subject, level: 'pass', evidence } : { subject, level: worst, evidence },
    )
  }
  return results
}

/**
 * The framework support check. It reads the repo's own lockfiles, so every deployment source
 * answers it fully. With no support data yet (fresh install, no network) it returns nothing and
 * every row is left alone.
 */
export const frameworkSupportGuard: Guard = {
  check: 'framework_support',
  capabilities: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 'full' as const])),
  run(ctx) {
    return ctx.support ? evaluateRepo(ctx, ctx.support) : []
  },
}
