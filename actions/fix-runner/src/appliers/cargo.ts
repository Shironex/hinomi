import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { isSafeRepoPath, type FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { CRATES_IO_API } from '../registry.js'
import { MINUTES_PER_DAY, type RepoGate } from '../release-age.js'
import { repoJoin } from '../repo-fs.js'
import { compareVersions, parseVersion } from '../semver.js'
import { scalarValue, scanInlineTable, scanToml, type TomlEntry } from '../toml.js'
import type { Applier, EditOutcome, InstallOptions, ProjectContext } from './types.js'

// Cargo with Cargo.lock. A transitive or in range fix is a lockfile_update: nothing is edited,
// the lockfile step runs `cargo update -p name@from --precise to` for each locked `from`. A
// major is a manifest_bump: the version requirement is rewritten in each Cargo.toml that
// declares the crate (or in `[workspace.dependencies]` for members that inherit it), then
// `cargo update --workspace` locks the new requirement and a precise update pins it to `to`,
// so a newer release than the one that passed the release age check never slips in.
// `cargo update` only resolves: it writes Cargo.lock and never builds, so no build script or
// proc macro runs in the lockfile step.

/** Lockfile `source` values of crates.io, the only registry publish times are read from. */
const CRATES_IO_SOURCES = [
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]

const METADATA_TIMEOUT_MS = 120_000

export interface LockedCrate {
  name: string
  version: string
  /** Null for workspace members and path crates. */
  source: string | null
}

/** Every `[[package]]` of a Cargo.lock. */
export function cargoLockPackages(text: string): LockedCrate[] {
  const blocks = new Map<number, Partial<LockedCrate>>()
  for (const entry of scanToml(text)) {
    if (!entry.arrayTable || entry.table.join('.') !== 'package' || entry.key.length !== 1) continue
    const value = scalarValue(text, entry)
    if (typeof value !== 'string') continue
    const block = blocks.get(entry.tableIndex) ?? {}
    const field = entry.key[0]
    if (field === 'name' || field === 'version' || field === 'source') block[field] = value
    blocks.set(entry.tableIndex, block)
  }
  const crates: LockedCrate[] = []
  for (const block of blocks.values()) {
    if (block.name && block.version) {
      crates.push({ name: block.name, version: block.version, source: block.source ?? null })
    }
  }
  return crates
}

/** Every version of `crateName` in a Cargo.lock. */
export function cargoLockVersions(text: string, crateName: string): string[] {
  const versions = cargoLockPackages(text)
    .filter((locked) => locked.name === crateName)
    .map((locked) => locked.version)
  return [...new Set(versions)]
}

/**
 * The part of a version cargo treats as compatible: `2` for 2.x, `0.4` for 0.4.x, `0.0.3`
 * for 0.0.3. Also a valid partial version for a package ID spec (`name@0.4`).
 */
export function compatBucket(version: string): string | null {
  const parsed = parseVersion(version)
  if (!parsed) return null
  if (parsed.major > 0) return String(parsed.major)
  if (parsed.minor > 0) return `0.${parsed.minor}`
  return `0.0.${parsed.patch}`
}

/**
 * Locked versions a lockfile_update moves: below `to` and either named in the step's `from`
 * or semver compatible with `to` (the lockfile may have moved since the scan).
 */
export function preciseSources(locked: string[], from: readonly string[], to: string): string[] {
  const bucket = compatBucket(to)
  return locked
    .filter((version) => compareVersions(version, to) < 0)
    .filter((version) => from.includes(version) || compatBucket(version) === bucket)
    .sort(compareVersions)
}

// ---------------------------------------------------------------------------
// Cargo.toml

const DEPENDENCY_TABLES = new Set([
  'dependencies',
  'dev-dependencies',
  'build-dependencies',
  'dev_dependencies',
  'build_dependencies',
])

/** Length of the dependency table part of a header, 0 when the header is not one. */
function dependencyTableLength(table: string[]): number {
  if (DEPENDENCY_TABLES.has(table[0] ?? '')) return 1
  if (table[0] === 'target' && DEPENDENCY_TABLES.has(table[2] ?? '')) return 3
  if (table[0] === 'workspace' && table[1] === 'dependencies') return 2
  return 0
}

export interface CargoDependency {
  /** The dependency table, e.g. `dependencies`, `target.cfg(unix).dev-dependencies`. */
  table: string
  /** The key it is declared under; the crate name unless `package` renames it. */
  key: string
  /** `package = "..."` of a renamed dependency. */
  packageName: string | null
  /** The version requirement string, when there is one. */
  version: TomlEntry | null
  /** `workspace = true`: the requirement lives in `[workspace.dependencies]`. */
  workspace: boolean
  /** Declares `git` or `path`. */
  nonRegistry: boolean
}

/** Every dependency a Cargo.toml declares, in every dependency table and form. */
export function cargoDependencies(text: string): CargoDependency[] {
  const found = new Map<string, CargoDependency>()
  const declare = (table: string, key: string) => {
    const id = `${table}\0${key}`
    let dependency = found.get(id)
    if (!dependency) {
      dependency = {
        table,
        key,
        packageName: null,
        version: null,
        workspace: false,
        nonRegistry: false,
      }
      found.set(id, dependency)
    }
    return dependency
  }
  const setField = (dependency: CargoDependency, field: string, entry: TomlEntry) => {
    const value = scalarValue(text, entry)
    if (field === 'version') dependency.version = entry
    else if (field === 'package' && typeof value === 'string') dependency.packageName = value
    else if (field === 'workspace') dependency.workspace = value === true
    else if (field === 'git' || field === 'path') dependency.nonRegistry = true
  }
  for (const entry of scanToml(text)) {
    const length = dependencyTableLength(entry.table)
    if (length === 0) continue
    const table = entry.table.slice(0, length).join('.')
    const [first, ...rest] = entry.key
    if (first === undefined) continue
    if (entry.table.length === length + 1) {
      // `[dependencies.serde]` with `version = "1"` inside.
      const key = entry.table[length]
      if (key !== undefined && rest.length === 0) setField(declare(table, key), first, entry)
      continue
    }
    if (entry.table.length !== length) continue
    const dependency = declare(table, first)
    if (rest.length === 1 && rest[0] !== undefined) {
      setField(dependency, rest[0], entry)
    } else if (rest.length === 0 && text[entry.start] === '{') {
      for (const inner of scanInlineTable(text, entry.start, entry.end)) {
        if (inner.key.length === 1 && inner.key[0] !== undefined) {
          setField(dependency, inner.key[0], inner)
        }
      }
    } else if (rest.length === 0) {
      dependency.version = entry
    }
  }
  return [...found.values()]
}

// `1.2.3`, `^1.2`, `~1`, `=1.2.3`, `>=1.2.0`: one comparator with a plain version.
const REQUIREMENT = /^(\s*)(\^|~|=|>=)?(\s*)(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(\s*)$/

/**
 * The requirement with its version replaced by `to` and its operator kept; null when it is
 * not a single plain comparator (`*`, `1.*`, `>=1, <2`, ...).
 */
export function bumpRequirement(requirement: string, to: string): string | null {
  const match = REQUIREMENT.exec(requirement)
  if (!match) return null
  const [, lead = '', operator = '', gap = '', , , , , trail = ''] = match
  return `${lead}${operator}${gap}${to}${trail}`
}

/** The lowest version a requirement names, missing parts as 0, for comparisons with `to`. */
function requirementFloor(requirement: string): string | null {
  const match = REQUIREMENT.exec(requirement)
  if (!match) return null
  return `${match[4]}.${match[5] ?? '0'}.${match[6] ?? '0'}${match[7] ?? ''}`
}

export interface ManifestBump {
  text: string
  /** Declarations rewritten. */
  changed: number
  /** Declarations of the crate found, rewritten or already new enough. */
  declared: number
  /** Some declaration inherits from `[workspace.dependencies]`. */
  inherits: boolean
  /** Set when a declaration cannot be rewritten: why. */
  manual: string | null
}

/**
 * Rewrites the requirement of `crateName` to `to` in one Cargo.toml. `scope` picks the
 * tables: a member's own dependency tables, or the workspace root's `[workspace.dependencies]`.
 * Requirements that already allow nothing below `to` stay as they are.
 */
export function bumpCargoManifest(
  text: string,
  crateName: string,
  to: string,
  scope: 'member' | 'workspace',
): ManifestBump {
  const result: ManifestBump = { text, changed: 0, declared: 0, inherits: false, manual: null }
  const replacements: Array<{ start: number; end: number; value: string }> = []
  for (const dependency of cargoDependencies(text)) {
    if ((dependency.packageName ?? dependency.key) !== crateName) continue
    const isWorkspaceTable = dependency.table === 'workspace.dependencies'
    if (isWorkspaceTable !== (scope === 'workspace')) continue
    result.declared++
    const where = `[${dependency.table}] ${dependency.key}`
    if (dependency.workspace) {
      result.inherits = true
      continue
    }
    if (!dependency.version) {
      result.manual = dependency.nonRegistry
        ? `${where} is a git or path dependency`
        : `${where} has no version`
      continue
    }
    const raw = text.slice(dependency.version.start, dependency.version.end)
    const requirement = scalarValue(text, dependency.version)
    const floor = typeof requirement === 'string' ? requirementFloor(requirement) : null
    const next = typeof requirement === 'string' ? bumpRequirement(requirement, to) : null
    if (next === null || floor === null) {
      result.manual = `${where} has ${raw}`
      continue
    }
    if (compareVersions(floor, to) >= 0) continue
    // Keep the quote style: only the characters between the quotes change.
    replacements.push({
      start: dependency.version.start + 1,
      end: dependency.version.end - 1,
      value: next,
    })
  }
  let next = text
  for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, start) + value + next.slice(end)
  }
  return { ...result, text: next, changed: replacements.length }
}

// ---------------------------------------------------------------------------
// cargo metadata

export interface CargoWorkspace {
  /** Repo relative path of the workspace root's Cargo.toml. */
  rootManifest: string
  members: Array<{ name: string; manifest: string }>
}

/** The JSON document in `cargo metadata` output, which may carry warnings around it. */
export function parseCargoMetadata(output: string): unknown {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .findLast((l) => l.startsWith('{'))
  if (!line) throw new Error('cargo metadata printed no JSON')
  return JSON.parse(line)
}

async function repoRelative(ctx: ProjectContext, absolute: string): Promise<string | null> {
  const bases = [ctx.fs.root]
  try {
    bases.push(await realpath(ctx.fs.root))
  } catch {
    // The root itself is the only base then.
  }
  for (const base of bases) {
    const rel = relative(base, absolute).split('\\').join('/')
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && isSafeRepoPath(rel)) return rel
  }
  return null
}

const workspaces = new WeakMap<ProjectContext, Promise<CargoWorkspace | string>>()

/** The workspace's members and their manifests, or why they could not be read. Cached. */
export function cargoWorkspace(ctx: ProjectContext): Promise<CargoWorkspace | string> {
  let pending = workspaces.get(ctx)
  if (!pending) {
    pending = readWorkspace(ctx)
    workspaces.set(ctx, pending)
  }
  return pending
}

async function readWorkspace(ctx: ProjectContext): Promise<CargoWorkspace | string> {
  const command: Command = {
    file: 'cargo',
    args: ['metadata', '--format-version', '1', '--no-deps'],
  }
  const result = await ctx.exec.run(command, {
    cwd: ctx.fs.absolute(ctx.root),
    timeoutMs: METADATA_TIMEOUT_MS,
  })
  if (result.code !== 0) {
    const last = result.output.trim().split('\n').pop() ?? ''
    return `cargo metadata failed: ${last.slice(0, 200)}`
  }
  let doc: unknown
  try {
    doc = parseCargoMetadata(result.output)
  } catch {
    return 'cargo metadata printed no JSON'
  }
  const meta = doc as {
    workspace_root?: unknown
    packages?: Array<{ name?: unknown; manifest_path?: unknown }>
  }
  if (typeof meta.workspace_root !== 'string' || !Array.isArray(meta.packages)) {
    return 'cargo metadata output has no workspace'
  }
  const rootManifest = await repoRelative(ctx, `${meta.workspace_root}/Cargo.toml`)
  if (!rootManifest) return 'the workspace root is outside the repo'
  const members: CargoWorkspace['members'] = []
  for (const pkg of meta.packages) {
    if (typeof pkg.name !== 'string' || typeof pkg.manifest_path !== 'string') continue
    const manifest = await repoRelative(ctx, pkg.manifest_path)
    if (manifest?.endsWith('Cargo.toml')) members.push({ name: pkg.name, manifest })
  }
  return { rootManifest, members }
}

// ---------------------------------------------------------------------------
// Steps

function failed(detail: string): EditOutcome {
  return { status: 'failed', reason: 'edit_failed', detail }
}

async function lockedVersions(ctx: ProjectContext, crateName: string): Promise<string[]> {
  const text = await ctx.fs.read(ctx.lockfile)
  if (text === null) return []
  try {
    return cargoLockVersions(text, crateName)
  } catch {
    return []
  }
}

/** lockfile_update edits nothing; it only checks there is a locked version to move. */
async function checkPrecise(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'lockfile_update') return failed(`${apply.type} is not a lockfile update`)
  const locked = await lockedVersions(ctx, apply.packageName)
  if (preciseSources(locked, apply.from, apply.to).length === 0) {
    return failed(
      `${ctx.lockfile} has ${apply.packageName} ${locked.join(', ')}, none that cargo update --precise ${apply.to} can move`,
    )
  }
  return { status: 'edited', files: [] }
}

async function bumpManifests(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'manifest_bump') return failed(`${apply.type} is not a manifest bump`)
  const workspace = await cargoWorkspace(ctx)
  if (typeof workspace === 'string') return failed(workspace)
  let targets = workspace.members
  if (step.workspaces.length > 0) {
    const missing = step.workspaces.filter((name) => !targets.some((m) => m.name === name))
    if (missing.length > 0) return failed(`not a workspace member: ${missing.join(', ')}`)
    targets = targets.filter((member) => step.workspaces.includes(member.name))
  }

  const texts = new Map<string, string>()
  const read = async (path: string) => texts.get(path) ?? (await ctx.fs.read(path))
  const changed = new Set<string>()
  let declared = 0
  let inherits = false
  const bumpIn = async (path: string, scope: 'member' | 'workspace') => {
    const text = await read(path)
    if (text === null) return `${path} does not exist`
    let bump: ManifestBump
    try {
      bump = bumpCargoManifest(text, apply.packageName, apply.version, scope)
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (bump.manual) return { manual: `${path} ${bump.manual}` }
    declared += bump.declared
    inherits ||= bump.inherits
    texts.set(path, bump.text)
    if (bump.changed > 0) changed.add(path)
    return null
  }
  for (const member of [...new Set(targets.map((t) => t.manifest))]) {
    const problem = await bumpIn(member, 'member')
    if (typeof problem === 'string') return failed(problem)
    if (problem) return { status: 'skipped', reason: 'manual_specifier', detail: problem.manual }
  }
  if (inherits) {
    const before = declared
    const problem = await bumpIn(workspace.rootManifest, 'workspace')
    if (typeof problem === 'string') return failed(problem)
    if (problem) return { status: 'skipped', reason: 'manual_specifier', detail: problem.manual }
    if (declared === before) {
      return failed(
        `${workspace.rootManifest} has no [workspace.dependencies] ${apply.packageName}`,
      )
    }
  }
  if (declared === 0) {
    return failed(
      `no Cargo.toml of ${step.workspaces.join(', ') || 'the workspace'} declares ${apply.packageName}`,
    )
  }
  for (const path of changed) await ctx.fs.write(path, texts.get(path) ?? '')
  return { status: 'edited', files: [...changed].sort() }
}

function update(args: string[]): Command {
  return { file: 'cargo', args: ['update', ...args] }
}

/** The cargo update commands for the steps of one attempt, in plan order. */
export async function cargoUpdateCommands(
  ctx: ProjectContext,
  steps: readonly FixDispatchStep[],
): Promise<Command[]> {
  const text = (await ctx.fs.read(ctx.lockfile)) ?? ''
  let packages: LockedCrate[]
  try {
    packages = cargoLockPackages(text)
  } catch {
    packages = []
  }
  const versionsOf = (name: string) =>
    packages.filter((locked) => locked.name === name).map((locked) => locked.version)
  const commands: Command[] = []
  // Locks the bumped requirements; other crates move only when they are not locked yet.
  if (steps.some((step) => step.apply.type === 'manifest_bump'))
    commands.push(update(['--workspace']))
  for (const { apply } of steps) {
    if (apply.type === 'lockfile_update') {
      for (const from of preciseSources(versionsOf(apply.packageName), apply.from, apply.to)) {
        commands.push(update(['-p', `${apply.packageName}@${from}`, '--precise', apply.to]))
      }
    } else if (apply.type === 'manifest_bump') {
      const bucket = compatBucket(apply.version)
      const settled = versionsOf(apply.packageName).some(
        (version) =>
          compatBucket(version) === bucket && compareVersions(version, apply.version) >= 0,
      )
      // `--workspace` takes the newest release the new requirement allows; pin it to `to`.
      if (bucket && !settled) {
        commands.push(update(['-p', `${apply.packageName}@${bucket}`, '--precise', apply.version]))
      }
    }
  }
  return commands
}

const DURATION = /^\s*(\d+)\s*(second|minute|hour|day|week|month)s?\s*$/
const DURATION_MINUTES: Record<string, number> = {
  second: 1 / 60,
  minute: 1,
  hour: 60,
  day: MINUTES_PER_DAY,
  week: 7 * MINUTES_PER_DAY,
  // Cargo does not say how long a month is; 30 days is the shorter common reading.
  month: 30 * MINUTES_PER_DAY,
}

/** Minutes of a cargo duration such as `14 days`, null when it is not one. */
export function parseCargoDuration(value: string): number | null {
  if (value.trim() === '0') return 0
  const match = DURATION.exec(value)
  const unit = match?.[2] ? DURATION_MINUTES[match[2]] : undefined
  return match && unit !== undefined ? Math.ceil(Number(match[1]) * unit) : null
}

/**
 * The repo's `registry.min-publish-age` (or `global-min-publish-age`) from .cargo/config.toml.
 * Stable cargo does not enforce it yet (`-Zmin-publish-age` is nightly only), but a repo that
 * sets it asked for that gate, so the runner applies it itself.
 */
export async function cargoConfigGate(ctx: ProjectContext): Promise<RepoGate | null> {
  const folders = [...new Set([ctx.root, '.'])]
  for (const folder of folders) {
    for (const name of ['.cargo/config.toml', '.cargo/config']) {
      const path = repoJoin(folder, name)
      const text = await ctx.fs.read(path)
      if (text === null) continue
      let entries: TomlEntry[]
      try {
        entries = scanToml(text)
      } catch {
        continue
      }
      for (const field of ['min-publish-age', 'global-min-publish-age']) {
        const entry = entries.find((e) => [...e.table, ...e.key].join('.') === `registry.${field}`)
        const value = entry ? scalarValue(text, entry) : null
        const minutes = typeof value === 'string' ? parseCargoDuration(value) : null
        if (minutes !== null) return { minutes, source: `${path} registry.${field}`, exclude: [] }
      }
    }
  }
  return null
}

export const cargoApplier: Applier = {
  packageManager: 'cargo',
  lockfiles: ['Cargo.lock'],
  versionCommand: { file: 'cargo', args: ['--version'] },

  resolvedVersions: lockedVersions,

  releaseAgeGate: cargoConfigGate,

  async publishedAt(ctx, crateName, version) {
    const text = await ctx.fs.read(ctx.lockfile)
    let sources: Array<string | null>
    try {
      sources = cargoLockPackages(text ?? '')
        .filter((locked) => locked.name === crateName)
        .map((locked) => locked.source)
    } catch {
      return null
    }
    // A crate from another registry has no crates.io publish time to trust.
    if (!sources.some((source) => source !== null && CRATES_IO_SOURCES.includes(source))) {
      return null
    }
    return ctx.publishTimes.publishedAt(crateName, version, CRATES_IO_API)
  },

  applyStep(ctx, step) {
    return step.apply.type === 'lockfile_update'
      ? checkPrecise(ctx, step)
      : bumpManifests(ctx, step)
  },

  lockfileInstall(ctx, { steps }: InstallOptions) {
    return cargoUpdateCommands(ctx, steps)
  },

  fullInstall() {
    return { file: 'cargo', args: ['fetch', '--locked'] }
  },

  checks() {
    const env = { CARGO_TERM_COLOR: 'never' }
    return Promise.resolve([
      {
        name: 'cargo check',
        command: { file: 'cargo', args: ['check', '--locked', '--all-targets'], env },
      },
      { name: 'cargo test', command: { file: 'cargo', args: ['test', '--locked'], env } },
    ])
  },
}
