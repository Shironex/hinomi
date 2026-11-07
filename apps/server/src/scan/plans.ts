import {
  FINDING_TIERS,
  FIX_PLAN_VERSION,
  type BumpLevel,
  type DependencyRelationship,
  type FindingTier,
  type FixPlan,
  type FixPlanApply,
  type FixPlanPrevious,
  type FixPlanProject,
  type FixPlanRiskReason,
  type FixPlanStep,
  type FixPlanUnfixed,
  type LockfileDependency,
  type PackageManager,
  type RepoRef,
} from '@hinomi/shared'
import type { FindingRow, RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { compareVersions, type OsvClient } from '../sources/osv/index.js'
import type { RepoScan } from './collect.js'
import { isFixable, type FixableFinding } from './fixes.js'
import { tierOf } from './rank.js'
import {
  askOsv,
  bumpLevel,
  chooseTarget,
  knownFromRow,
  packageKey,
  type KnownAdvisory,
  type OsvAnswer,
  type TargetChoice,
  type TargetFacts,
  type TargetQuery,
} from './targets.js'
import { listRankedFindings } from './views.js'

export { bumpLevel } from './targets.js'

// One upgrade plan per repo: every open fixable finding lands in a step or in `unfixed`.
// Steps are data a runner applies without judgement; see fixPlanApplySchema in packages/shared.

/** The lockfiles one scan read for a repo, with every package in them. */
export interface RepoLockfiles {
  /** Repo relative lockfile paths. */
  lockfiles: readonly string[]
  /** Packages of those lockfiles, each tagged with its lockfile. */
  dependencies: readonly LockfileDependency[]
}

export interface BuildFixPlanInput {
  repo: RepoRow
  scanRunId: number
  createdAt: Date
  /** Open fixable findings of this repo, most urgent first. */
  findings: readonly FixableFinding[]
  /** Null when OSV did not read the repo this scan: the plan falls back to what findings say. */
  lockfiles: RepoLockfiles | null
  previous: FixPlanPrevious | null
  /**
   * Known advisories for the target check. Without it every step targets the highest first
   * patched version of its findings, unchecked.
   */
  targets?: TargetFacts
}

export function toRepoRef(repo: RepoRow): RepoRef {
  return {
    id: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: `${repo.owner}/${repo.name}`,
    archived: repo.archived,
    alertsEnabled: repo.alertsEnabled,
    lastScannedAt: repo.lastScannedAt ? repo.lastScannedAt.toISOString() : null,
  }
}

const LOCKFILE_MANAGERS: Record<string, PackageManager> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'Cargo.lock': 'cargo',
}

const OVERRIDE_FIELDS = {
  pnpm: 'pnpm.overrides',
  npm: 'overrides',
  bun: 'overrides',
  yarn: 'resolutions',
} as const

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')
const joinPath = (folder: string, path: string) =>
  folder === '.' ? path : path === '.' ? folder : `${folder}/${path}`

/** The package manager a lockfile belongs to, `unknown` for anything else. */
export function packageManagerOf(lockfile: string | null): PackageManager {
  if (lockfile === null) return 'unknown'
  return LOCKFILE_MANAGERS[basename(lockfile)] ?? 'unknown'
}

/** Lockfiles name the Rust ecosystem `crates.io`; advisories are stored as `rust`. */
function lockfileEcosystem(ecosystem: string): LockfileDependency['ecosystem'] | null {
  if (ecosystem === 'npm') return 'npm'
  if (ecosystem === 'rust' || ecosystem === 'crates.io') return 'crates.io'
  return null
}

const LEVEL_WEIGHT: Record<BumpLevel, number> = { patch: 0, minor: 1, major: 2, unknown: 3 }

function widestLevel(from: readonly string[], to: string): BumpLevel {
  if (from.length === 0) return 'unknown'
  return from
    .map((v) => bumpLevel(v, to))
    .reduce((wide, level) => (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[wide] ? level : wide))
}

function highest(versions: Iterable<string>): string | null {
  let best: string | null = null
  for (const v of versions) if (best === null || compareVersions(v, best) > 0) best = v
  return best
}

const sortedVersions = (versions: Iterable<string>) => [...new Set(versions)].sort(compareVersions)
const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort()

/** Where one finding's package sits: one lockfile, direct or transitive. */
interface Placement {
  lockfile: string | null
  relationship: DependencyRelationship
  workspaces: string[]
  via: string[]
  installed: string[]
}

/** Workspaces relative to the repo: folders under the lockfile's root, crate names as they are. */
function repoWorkspaces(dep: LockfileDependency, lockfile: string): string[] {
  const root = dirname(lockfile)
  if (dep.ecosystem === 'crates.io') return dep.workspaces ?? []
  return (dep.workspaces ?? []).map((ws) => joinPath(root, ws))
}

function placementsFromLockfiles(
  finding: FixableFinding,
  lockfiles: RepoLockfiles,
): Placement[] | null {
  const ecosystem = lockfileEcosystem(finding.advisory.ecosystem)
  const installed = finding.finding.installedVersion
  if (!ecosystem || installed === null) return null
  const byLockfile = new Map<string, LockfileDependency[]>()
  for (const dep of lockfiles.dependencies) {
    if (!dep.lockfile || dep.ecosystem !== ecosystem) continue
    if (dep.name !== finding.advisory.packageName || dep.version !== installed) continue
    byLockfile.set(dep.lockfile, [...(byLockfile.get(dep.lockfile) ?? []), dep])
  }
  if (byLockfile.size === 0) return null
  return [...byLockfile].map(([lockfile, deps]) => {
    const direct = deps.some((d) => d.direct)
    return {
      lockfile,
      relationship: direct ? 'direct' : 'transitive',
      workspaces: sortedUnique(deps.flatMap((d) => repoWorkspaces(d, lockfile))),
      via: direct
        ? []
        : sortedUnique(deps.flatMap((d) => (d.path && d.path.length > 1 ? [d.path[0]!] : []))),
      installed: [installed],
    }
  })
}

/** The lockfile a finding names: one it was read from, or the lockfile beside its manifest. */
function lockfileOfFinding(finding: FindingRow, lockfiles: RepoLockfiles | null): string | null {
  const named = finding.manifestPaths.find((p) => packageManagerOf(p) !== 'unknown')
  if (named) return named
  const manifest = finding.manifestPaths[0]
  if (!manifest) return null
  const sibling = lockfiles?.lockfiles.find((l) => dirname(l) === dirname(manifest))
  return sibling ?? manifest
}

/** Without lockfile data: the manifest path and dependency path stored on the finding. */
function placementFromFinding(finding: FixableFinding, lockfiles: RepoLockfiles | null): Placement {
  const path = finding.finding.dependencyPath ?? []
  const relationship: DependencyRelationship =
    path.length === 1 ? 'direct' : path.length > 1 ? 'transitive' : 'unknown'
  const installed = finding.finding.installedVersion
  return {
    lockfile: lockfileOfFinding(finding.finding, lockfiles),
    relationship,
    workspaces: [],
    via: relationship === 'transitive' ? [path[0]!] : [],
    installed: installed === null ? [] : [installed],
  }
}

function placementsOf(finding: FixableFinding, lockfiles: RepoLockfiles | null): Placement[] {
  return (
    (lockfiles && placementsFromLockfiles(finding, lockfiles)) ?? [
      placementFromFinding(finding, lockfiles),
    ]
  )
}

/** Findings of one package in one lockfile with one relationship: a step and/or an unfixed entry. */
interface Group {
  ecosystem: string
  packageName: string
  lockfile: string | null
  relationship: DependencyRelationship
  workspaces: Set<string>
  via: Set<string>
  installed: Set<string>
  findings: FixableFinding[]
}

function groupFindings(
  findings: readonly FixableFinding[],
  lockfiles: RepoLockfiles | null,
): Group[] {
  const groups = new Map<string, Group>()
  for (const finding of findings) {
    const { ecosystem, packageName } = finding.advisory
    for (const placement of placementsOf(finding, lockfiles)) {
      const key = [placement.lockfile ?? '', ecosystem, packageName, placement.relationship].join(
        '\u0000',
      )
      const group = groups.get(key) ?? {
        ecosystem,
        packageName,
        lockfile: placement.lockfile,
        relationship: placement.relationship,
        workspaces: new Set<string>(),
        via: new Set<string>(),
        installed: new Set<string>(),
        findings: [],
      }
      for (const ws of placement.workspaces) group.workspaces.add(ws)
      for (const v of placement.via) group.via.add(v)
      for (const v of placement.installed) group.installed.add(v)
      if (!group.findings.includes(finding)) group.findings.push(finding)
      groups.set(key, group)
    }
  }
  return [...groups.values()]
}

const patchOf = (f: FixableFinding): string | null => f.advisory.firstPatchedVersion?.trim() || null

function tierCounts(findings: readonly FixableFinding[]): Record<FindingTier, number> {
  const counts = Object.fromEntries(FINDING_TIERS.map((t) => [t, 0])) as Record<FindingTier, number>
  for (const f of findings) counts[tierOf(f)]++
  return counts
}

const tierIndex = (tier: FindingTier) => FINDING_TIERS.indexOf(tier)
const bestTierIndex = (findings: readonly FixableFinding[]) =>
  Math.min(...findings.map((f) => tierIndex(tierOf(f))))

function targetFields(group: Group, findings: readonly FixableFinding[]) {
  return {
    ecosystem: group.ecosystem,
    packageName: group.packageName,
    relationship: group.relationship,
    lockfile: group.lockfile,
    packageManager: packageManagerOf(group.lockfile),
    workspaces: group.relationship === 'direct' ? sortedUnique(group.workspaces) : [],
    via: sortedUnique(group.via),
    findingIds: findings.map((f) => f.finding.id),
    advisories: sortedUnique(findings.map((f) => f.advisory.advisoryKey)),
    byTier: tierCounts(findings),
  }
}

function applyOf(group: Group, from: string[], to: string, level: BumpLevel): FixPlanApply {
  const manager = packageManagerOf(group.lockfile)
  const { packageName } = group
  if (manager === 'unknown' || group.lockfile === null) return { type: 'manual' }
  if (manager === 'cargo') {
    if (group.relationship === 'direct' && level === 'major') {
      return { type: 'manifest_bump', manifests: [], packageName, version: to }
    }
    return { type: 'lockfile_update', tool: 'cargo', packageName, from, to }
  }
  const root = dirname(group.lockfile)
  if (group.relationship === 'direct') {
    const folders = group.workspaces.size > 0 ? sortedUnique(group.workspaces) : [root]
    return {
      type: 'manifest_bump',
      manifests: folders.map((f) => joinPath(f, 'package.json')),
      packageName,
      version: to,
    }
  }
  return {
    type: 'override',
    manifest: joinPath(root, 'package.json'),
    field: OVERRIDE_FIELDS[manager],
    key: packageName,
    value: to,
  }
}

/** Versions of the package in the group's lockfile that the step does not mean to move. */
function pinsOtherVersions(group: Group, lockfiles: RepoLockfiles | null): boolean {
  if (!lockfiles || group.lockfile === null) return false
  const ecosystem = lockfileEcosystem(group.ecosystem)
  return lockfiles.dependencies.some(
    (d) =>
      d.lockfile === group.lockfile &&
      d.ecosystem === ecosystem &&
      d.name === group.packageName &&
      !group.installed.has(d.version),
  )
}

function riskNote(
  reasons: readonly FixPlanRiskReason[],
  name: string,
  from: string[],
  to: string,
): string | null {
  const notes: Record<FixPlanRiskReason, string> = {
    semver_major: `Semver major (${from.join(', ') || 'unknown'} to ${to}): read the changelog of ${name} before merging.`,
    pins_other_versions: `The override also moves other installed versions of ${name}.`,
    unknown_version: `The versions of ${name} are not semver: read the changelog.`,
    unknown_relationship: `Hinomi could not tell whether ${name} is a direct or a transitive dependency.`,
    unknown_package_manager: `No lockfile Hinomi reads lists ${name}: apply this step by hand.`,
  }
  return reasons.length === 0 ? null : reasons.map((r) => notes[r]).join(' ')
}

type DraftStep = Omit<FixPlanStep, 'order'>

/** The step's target: checked against known advisories when the plan has them. */
function targetOf(group: Group, minimum: string, facts: TargetFacts | undefined): TargetChoice {
  if (!facts) return { kind: 'skip' }
  return chooseTarget({
    ecosystem: group.ecosystem,
    packageName: group.packageName,
    minimum,
    facts,
  })
}

const joinNotes = (...notes: (string | null)[]) =>
  notes.filter((n): n is string => n !== null).join(' ') || null

function buildStep(
  group: Group,
  findings: FixableFinding[],
  lockfiles: RepoLockfiles | null,
  target: TargetChoice,
): DraftStep {
  const minimum = highest(findings.flatMap((f) => patchOf(f) ?? []))!
  const to = target.kind === 'done' ? target.to : minimum
  const from = sortedVersions(group.installed)
  const level = widestLevel(from, to)
  const apply = applyOf(group, from, to, level)
  const reasons: FixPlanRiskReason[] = []
  if (level === 'major') reasons.push('semver_major')
  if (level === 'unknown') reasons.push('unknown_version')
  if (apply.type === 'override' && pinsOtherVersions(group, lockfiles)) {
    reasons.push('pins_other_versions')
  }
  if (group.relationship === 'unknown') reasons.push('unknown_relationship')
  if (apply.type === 'manual') reasons.push('unknown_package_manager')
  return {
    id: `${apply.type}:${group.ecosystem}:${group.packageName}:${to}:${group.lockfile ?? 'unknown'}`,
    ...targetFields(group, findings),
    from,
    to,
    level,
    risk: reasons.length > 0 ? 'risky' : 'safe',
    riskReasons: reasons,
    note: joinNotes(
      riskNote(reasons, group.packageName, from, to),
      target.kind === 'done' ? target.note : null,
    ),
    apply,
    releasedAt: null,
    releaseAge: 'unknown',
    ...(target.kind === 'done' && { targetCheck: target.check }),
  }
}

/** Safe direct bumps, then safe transitive fixes, then risky steps; urgent and big first. */
function stepRank(step: DraftStep): number {
  if (step.risk === 'risky') return 2
  return step.relationship === 'direct' ? 0 : 1
}

function compareSteps(
  a: { step: DraftStep; best: number },
  b: { step: DraftStep; best: number },
): number {
  return (
    stepRank(a.step) - stepRank(b.step) ||
    a.best - b.best ||
    b.step.findingIds.length - a.step.findingIds.length ||
    a.step.packageName.localeCompare(b.step.packageName) ||
    (a.step.lockfile ?? '').localeCompare(b.step.lockfile ?? '')
  )
}

function projectsOf(
  lockfiles: RepoLockfiles | null,
  steps: readonly DraftStep[],
  unfixed: readonly FixPlanUnfixed[],
): FixPlanProject[] {
  const paths = new Set(lockfiles?.lockfiles ?? [])
  for (const item of [...steps, ...unfixed]) {
    if (item.lockfile && packageManagerOf(item.lockfile) !== 'unknown') paths.add(item.lockfile)
  }
  return [...paths].sort().map((lockfile) => {
    const workspaces = (lockfiles?.dependencies ?? [])
      .filter((d) => d.lockfile === lockfile)
      .flatMap((d) => repoWorkspaces(d, lockfile))
    return {
      lockfile,
      root: dirname(lockfile),
      packageManager: packageManagerOf(lockfile),
      workspaces: sortedUnique(workspaces),
    }
  })
}

function uniqueFindings(lists: readonly (readonly number[])[], byId: Map<number, FixableFinding>) {
  const ids = new Set(lists.flat())
  return [...ids].flatMap((id) => byId.get(id) ?? [])
}

interface Draft {
  drafts: { step: DraftStep; best: number }[]
  unfixed: FixPlanUnfixed[]
  /** Target versions the check still wants OSV to answer for. */
  pending: TargetQuery[]
}

function draftPlan(input: BuildFixPlanInput): Draft {
  const drafts: Draft['drafts'] = []
  const unfixed: FixPlanUnfixed[] = []
  const pending: TargetQuery[] = []
  for (const group of groupFindings(input.findings, input.lockfiles)) {
    const patched = group.findings.filter((f) => patchOf(f) !== null)
    const unpatched = group.findings.filter((f) => patchOf(f) === null)
    if (patched.length > 0) {
      const minimum = highest(patched.flatMap((f) => patchOf(f) ?? []))!
      const target = targetOf(group, minimum, input.targets)
      if (target.kind === 'pending') pending.push(target.query)
      drafts.push({
        step: buildStep(group, patched, input.lockfiles, target),
        best: bestTierIndex(patched),
      })
    }
    if (unpatched.length > 0) {
      unfixed.push({
        ...targetFields(group, unpatched),
        installed: sortedVersions(group.installed),
        blocker: 'no_patch',
        availableAt: null,
      })
    }
  }
  return { drafts, unfixed, pending }
}

/** Versions the target check of this plan still wants OSV to answer for. */
export function pendingTargetQueries(input: BuildFixPlanInput): TargetQuery[] {
  return draftPlan(input).pending
}

/**
 * Builds the fix plan of one repo. Pure: the same input gives the same plan. A target still
 * pending an OSV answer stays the highest first patched version, unchecked.
 */
export function buildFixPlan(input: BuildFixPlanInput): FixPlan {
  const { drafts, unfixed } = draftPlan(input)
  const steps: FixPlanStep[] = drafts
    .sort(compareSteps)
    .map(({ step }, i) => ({ ...step, order: i + 1 }))
  unfixed.sort((a, b) => a.packageName.localeCompare(b.packageName))

  const byId = new Map(input.findings.map((f) => [f.finding.id, f]))
  const cleared = uniqueFindings(
    steps.map((s) => s.findingIds),
    byId,
  )
  const clearedSafely = uniqueFindings(
    steps.filter((s) => s.risk === 'safe').map((s) => s.findingIds),
    byId,
  )
  const left = uniqueFindings(
    unfixed.map((u) => u.findingIds),
    byId,
  )
  return {
    version: FIX_PLAN_VERSION,
    repo: toRepoRef(input.repo),
    scanRunId: input.scanRunId,
    createdAt: input.createdAt.toISOString(),
    projects: projectsOf(input.lockfiles, steps, unfixed),
    steps,
    unfixed,
    summary: {
      findings: {
        total: byId.size,
        cleared: cleared.length,
        clearedSafely: clearedSafely.length,
        unfixed: left.length,
        clearedByTier: tierCounts(cleared),
        unfixedByTier: tierCounts(left),
      },
      steps: {
        safe: steps.filter((s) => s.risk === 'safe').length,
        risky: steps.filter((s) => s.risk === 'risky').length,
      },
      unfixed: unfixed.length,
    },
    previous: input.previous,
  }
}

/** How an earlier plan's steps turned out: their findings fixed or still open by now. */
export function comparePlan(
  plan: FixPlan,
  stateOf: (findingId: number) => FindingRow['state'] | undefined,
): FixPlanPrevious {
  const ids = [...new Set(plan.steps.flatMap((s) => s.findingIds))]
  const states = ids.map(stateOf)
  const cleared = states.filter((s) => s === 'fixed').length
  return {
    scanRunId: plan.scanRunId,
    findings: ids.length,
    cleared,
    stillOpen: states.filter((s) => s !== undefined && s !== 'fixed').length,
  }
}

function lockfilesOf(scan: RepoScan): RepoLockfiles | null {
  if (scan.osv.status !== 'ok') return null
  return { lockfiles: scan.osv.value.lockfiles, dependencies: scan.osv.value.dependencies ?? [] }
}

/** Rounds of OSV questions per scan: each round can only add higher candidates. */
export const TARGET_CHECK_ROUNDS = 4

export interface SaveScanPlansOptions {
  /** The scan's OSV client, to check targets; null or absent when OSV is off. */
  osv?: OsvClient | null
  /** Told when OSV could not answer the target check. */
  warn?: (message: string, data: Record<string, unknown>) => void
}

/** Stored advisories of a package, read once per scan. */
function storedAdvisories(repositories: Repositories): TargetFacts['stored'] {
  const cache = new Map<string, KnownAdvisory[]>()
  return (ecosystem, packageName) => {
    const key = packageKey(ecosystem, packageName)
    let list = cache.get(key)
    if (!list) {
      list = repositories.advisories
        .forPackage(ecosystem, packageName)
        .flatMap((row) => knownFromRow(row) ?? [])
      cache.set(key, list)
    }
    return list
  }
}

function uniqueQueries(queries: readonly TargetQuery[]): TargetQuery[] {
  const byKey = new Map(
    queries.map((q) => [`${packageKey(q.ecosystem, q.packageName)}\u0000${q.version}`, q]),
  )
  return [...byKey.values()]
}

/**
 * Builds and stores a fix plan for every repo this scan saved, nothing to fix included, so the
 * next scan can say what this plan cleared. Runs once at the end of the ranking phase. Targets
 * are checked against stored advisories and, with an OSV client, OSV's answer for each candidate
 * version: one batch per round over every repo, cached for the scan.
 */
export async function saveScanPlans(
  repositories: Repositories,
  scanRunId: number,
  scans: ReadonlyMap<number, RepoScan>,
  now: Date,
  options: SaveScanPlansOptions = {},
): Promise<FixPlan[]> {
  const byRepo = new Map<number, FixableFinding[]>()
  for (const ranked of listRankedFindings(repositories)) {
    if (!isFixable(ranked)) continue
    byRepo.set(ranked.repo.id, [...(byRepo.get(ranked.repo.id) ?? []), ranked])
  }
  const stateOf = (id: number) => repositories.findings.get(id)?.state
  const answers = new Map<string, Map<string, OsvAnswer>>()
  const targets: TargetFacts = {
    stored: storedAdvisories(repositories),
    osv: options.osv ? answers : null,
  }
  const inputs: BuildFixPlanInput[] = [...scans].map(([repoId, scan]) => {
    const earlier = repositories.fixPlans.forRepo(repoId)
    return {
      repo: repositories.repos.get(repoId) ?? scan.repo,
      scanRunId,
      createdAt: now,
      findings: byRepo.get(repoId) ?? [],
      lockfiles: lockfilesOf(scan),
      previous:
        earlier && earlier.scanRunId !== scanRunId ? comparePlan(earlier.plan, stateOf) : null,
      targets,
    }
  })
  const pending = () => uniqueQueries(inputs.flatMap(pendingTargetQueries))
  for (let round = 0; options.osv && round < TARGET_CHECK_ROUNDS; round++) {
    const queries = pending()
    if (queries.length === 0) break
    const error = await askOsv(options.osv, queries, answers)
    if (error) {
      options.warn?.('scan: OSV could not check fix targets', {
        scanRunId,
        versions: queries.length,
        error,
      })
    }
  }
  // Versions still unanswered after the last round are taken unchecked.
  for (const query of pending()) {
    const key = packageKey(query.ecosystem, query.packageName)
    const versions = answers.get(key) ?? new Map<string, OsvAnswer>()
    answers.set(key, versions.set(query.version, 'unavailable'))
  }
  return inputs.map((input) => {
    const plan = buildFixPlan(input)
    repositories.fixPlans.save(plan, now)
    return plan
  })
}
