import { watchPathsTrigger, type WatchPathsSkipEvidence } from '@hinomi/shared'
import type { DeploymentRow } from '../../db/schema.js'
import type { Guard, GuardContext, GuardSubjectResult } from './types.js'

// watch_paths_skip (docs/design/phase-2.md section 4.4): will a change to the Dockerfile or a
// lockfile not trigger a deploy because the watch paths skip it? Uses the matcher the fix run
// warning uses (packages/shared watch-paths.ts).

/** Manifest each lockfile name belongs to (same folder). */
const MANIFESTS: ReadonlyMap<string, string> = new Map([
  ['pnpm-lock.yaml', 'package.json'],
  ['package-lock.json', 'package.json'],
  ['npm-shrinkwrap.json', 'package.json'],
  ['yarn.lock', 'package.json'],
  ['bun.lock', 'package.json'],
  ['bun.lockb', 'package.json'],
  ['Cargo.lock', 'Cargo.toml'],
  ['go.sum', 'go.mod'],
  ['poetry.lock', 'pyproject.toml'],
  ['uv.lock', 'pyproject.toml'],
  ['Pipfile.lock', 'Pipfile'],
  ['composer.lock', 'composer.json'],
  ['Gemfile.lock', 'Gemfile'],
])

/** A repo path without leading `/` or `./` and with no empty or `.` segments. */
function cleanPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

const dirOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** True when folder `a` is `b` or one of its parents (`''` is the repo root). */
const isAncestorOrSame = (a: string, b: string) => a === '' || a === b || b.startsWith(`${a}/`)

/**
 * Lockfiles (and their manifests) that build this app: those in its base folder, in a parent
 * of it, or inside it. Coolify only keeps the base folder of a Dockerfile app, so for other
 * build packs only the root lockfiles count rather than every folder of a monorepo.
 */
function buildFiles(lockfiles: readonly string[], baseDir: string | null): string[] {
  const files = new Set<string>()
  for (const lockfile of lockfiles) {
    const path = cleanPath(lockfile)
    const dir = dirOf(path)
    const related =
      baseDir === null
        ? dir === ''
        : isAncestorOrSame(dir, baseDir) || isAncestorOrSame(baseDir, dir)
    if (!related) continue
    files.add(path)
    const name = path.split('/').pop() ?? ''
    const manifest = MANIFESTS.get(name)
    if (manifest) files.add(dir === '' ? manifest : `${dir}/${manifest}`)
  }
  return [...files]
}

function evidence(over: Partial<WatchPathsSkipEvidence>): WatchPathsSkipEvidence {
  return {
    check: 'watch_paths_skip',
    patterns: [],
    autoDeploy: null,
    checked: [],
    skipped: [],
    reason: null,
    ...over,
  }
}

/** Repo ids each deployment runs, from the index (manual mappings honoured). */
function reposByDeployment(ctx: GuardContext): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const [repoId, deployments] of ctx.index.byRepo) {
    for (const deployment of deployments) {
      map.set(deployment.id, [...(map.get(deployment.id) ?? []), repoId])
    }
  }
  return map
}

function evaluate(
  row: DeploymentRow,
  repoIds: readonly number[],
  ctx: GuardContext,
): GuardSubjectResult | null {
  // Only applications have watch paths; services and databases deploy as a whole.
  if (row.kind !== 'application') return null
  const subject = { deploymentId: row.id }
  const facts = row.facts
  const patterns = row.watchPaths ?? []
  const unknown = (reason: string): GuardSubjectResult => ({
    subject,
    level: 'unknown',
    evidence: evidence({ patterns, autoDeploy: facts?.autoDeploy ?? null, reason }),
  })

  if (!facts) return unknown('the source has not reported the watch paths of this application yet')
  if (facts.gaps.watchPaths) return unknown(facts.gaps.watchPaths)
  const pass = (reason: string | null = null): GuardSubjectResult => ({
    subject,
    level: 'pass',
    evidence: evidence({ patterns, autoDeploy: facts.autoDeploy, reason }),
  })
  if (patterns.length === 0) return pass('no watch paths are set, so every change deploys')
  if (facts.autoDeploy === null)
    return unknown(facts.gaps.autoDeploy ?? 'it is not known whether automatic deploys are on')
  if (!facts.autoDeploy)
    return pass('automatic deploys are off, so watch paths only matter for hand started deploys')

  const dockerfile = facts.dockerfile
  const baseDir = dockerfile ? cleanPath(dockerfile.baseDirectory ?? '') : null
  const files: string[] = []
  if (dockerfile) {
    files.push(cleanPath(`${baseDir}/${dockerfile.location ?? 'Dockerfile'}`))
  }
  let note: string | null = null
  const lockfiles: string[] = []
  for (const repoId of repoIds) {
    const osv = ctx.scans.get(repoId)?.osv
    if (osv?.status === 'ok') lockfiles.push(...osv.value.lockfiles)
    else
      note = 'the lockfiles of the repo were not read in this scan, only the Dockerfile was checked'
  }
  for (const file of buildFiles(lockfiles, baseDir)) if (!files.includes(file)) files.push(file)
  if (files.length === 0)
    return pass(note ?? 'no Dockerfile or lockfile is known for this application')

  const skipped = files.filter((file) => !watchPathsTrigger(patterns, file))
  const detail = { patterns, autoDeploy: true, checked: files, skipped, reason: note }
  if (skipped.length === 0) return { subject, level: 'pass', evidence: evidence(detail) }
  return { subject, level: 'warn', evidence: evidence(detail) }
}

export function evaluateWatchPathsSkip(ctx: GuardContext): GuardSubjectResult[] {
  const repoIds = reposByDeployment(ctx)
  const results: GuardSubjectResult[] = []
  for (const row of ctx.deployments) {
    const result = evaluate(row, repoIds.get(row.id) ?? [], ctx)
    if (result) results.push(result)
  }
  return results
}

export const watchPathsSkipGuard: Guard = {
  check: 'watch_paths_skip',
  capabilities: { coolify: 'full' },
  run: evaluateWatchPathsSkip,
}
