import { accessSync, constants, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import type { FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { PYPI_API } from '../registry.js'
import { repoDirname, repoJoin, type RepoFs } from '../repo-fs.js'
import { scalarValue, scanInlineTable, scanToml, type TomlEntry } from '../toml.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// uv with uv.lock. A step is a lockfile_update: `uv lock --no-build --upgrade-package
// <name>==<to>` re-resolves only that package and writes uv.lock; nothing is installed and
// pyproject.toml is not edited, so a requirement whose range excludes `to` makes the lock fail
// and the step is reported as install_failed. `--no-build` is what keeps package code out:
// without it uv builds source distributions to read their metadata, which runs their setup
// code. With it uv takes metadata only from wheels and static source metadata, and a package
// that would need a build fails the lock instead.
//
// uv also looks for an interpreter before it resolves, and it runs the one it finds to ask its
// version: a committed `.venv` or a `.python-version` naming a path in the repo would be repo
// code. Every uv command therefore gets UV_ENV: an absolute interpreter found on the runner's
// PATH outside the checkout, a project environment in a temp folder, no Python downloads and a
// cache outside the checkout. UV_NO_CONFIG is not set: it would also drop the project's own
// [tool.uv] settings (exclude-newer, its indexes), so the lock would change beyond the step.
// What those settings point at is checked before a publish time is trusted (sourceIsPypi).

/** PEP 503 normalized name: lowercase, runs of `-`, `_` and `.` as one `-`. */
export const normalizePypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

/** The index URLs uv.lock records for PyPI. */
const PYPI_INDEXES = new Set(['https://pypi.org/simple', 'https://pypi.org/simple/'])

export interface LockedPythonPackage {
  /** Normalized. */
  name: string
  version: string
  /** `source.registry`, null for workspace, path, git and URL sources. */
  registry: string | null
}

/** Every `[[package]]` of a uv.lock with its registry. */
export function uvLockPackages(text: string): LockedPythonPackage[] {
  const blocks = new Map<number, Partial<LockedPythonPackage>>()
  for (const entry of scanToml(text)) {
    if (!entry.arrayTable || entry.table.join('.') !== 'package' || entry.key.length !== 1) continue
    const block = blocks.get(entry.tableIndex) ?? { registry: null }
    const field = entry.key[0]
    if (field === 'name' || field === 'version') {
      const value = scalarValue(text, entry)
      if (typeof value === 'string')
        block[field] = field === 'name' ? normalizePypiName(value) : value
    } else if (field === 'source') {
      const registry = scanInlineTable(text, entry.start, entry.end).find(
        (inner) => inner.key.join('.') === 'registry',
      )
      const value = registry ? scalarValue(text, registry) : null
      block.registry = typeof value === 'string' ? value : null
    }
    blocks.set(entry.tableIndex, block)
  }
  return [...blocks.values()].flatMap((block) =>
    block.name && block.version
      ? [{ name: block.name, version: block.version, registry: block.registry ?? null }]
      : [],
  )
}

async function lockedPackages(ctx: ProjectContext, name: string): Promise<LockedPythonPackage[]> {
  const text = await ctx.fs.read(ctx.lockfile)
  if (text === null) return []
  try {
    const wanted = normalizePypiName(name)
    return uvLockPackages(text).filter((pkg) => pkg.name === wanted)
  } catch {
    return []
  }
}

/** True when `path` is the checkout or inside it, symlinks resolved. */
function insideCheckout(checkout: string, path: string): boolean {
  try {
    const rel = relative(realpathSync(checkout), realpathSync(path))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return true
  }
}

/** The first executable `python3` on PATH that is an absolute path outside the checkout. */
export function runnerPython(checkout: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, 'python3')
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    if (!insideCheckout(checkout, candidate)) return candidate
  }
  return null
}

let scratch: string | null = null

/** A temp folder of this runner process, outside every checkout. */
function uvScratch(): string {
  scratch ??= mkdtempSync(join(tmpdir(), 'hinomi-uv-'))
  return scratch
}

/** The environment of every uv command (see the top of the file). */
export function uvEnv(checkout: string, python: string | null): Record<string, string> {
  const dir = uvScratch()
  return {
    // A path that does not exist makes uv fail with "No interpreter found" rather than search.
    UV_PYTHON: python ?? join(dir, 'no-python3-on-path'),
    UV_PYTHON_DOWNLOADS: 'never',
    UV_PROJECT_ENVIRONMENT: join(dir, 'venv'),
    UV_CACHE_DIR: join(dir, 'cache'),
    UV_KEYRING_PROVIDER: 'disabled',
    UV_NO_PROGRESS: '1',
  }
}

/** The single `uv lock` for the steps of one attempt, null when there is nothing to move. */
export function uvLockCommand(
  steps: readonly FixDispatchStep[],
  env: Record<string, string> = {},
): Command | null {
  const upgrades = steps.flatMap(({ apply }) =>
    apply.type === 'lockfile_update'
      ? ['--upgrade-package', `${apply.packageName}==${apply.to}`]
      : [],
  )
  if (upgrades.length === 0) return null
  return { file: 'uv', args: ['lock', '--no-build', ...upgrades], env }
}

/** [tool.uv] settings that point uv at an index other than PyPI. */
const UV_INDEX_SETTINGS = new Set([
  'index',
  'index-url',
  'default-index',
  'extra-index-url',
  'find-links',
  'no-index',
])

function entriesUnder(entries: TomlEntry[], table: string): TomlEntry[] {
  return entries.filter((entry) => entry.table.join('.') === table)
}

/**
 * Whether `name` can only come from PyPI under the project's current configuration: no
 * uv.toml in the project folder or above it in the repo, no [tool.uv] index setting, every
 * [[tool.uv.index]] PyPI or explicit, and no [tool.uv.sources] entry for the package.
 */
export async function sourceIsPypi(fs: RepoFs, root: string, name: string): Promise<boolean> {
  for (let dir = root; ; dir = repoDirname(dir)) {
    if (await fs.exists(repoJoin(dir, 'uv.toml'))) return false
    if (dir === '.') break
  }
  const text = await fs.read(repoJoin(root, 'pyproject.toml'))
  if (text === null) return false
  let entries: TomlEntry[]
  try {
    entries = scanToml(text)
  } catch {
    return false
  }
  if (entriesUnder(entries, 'tool.uv').some((e) => UV_INDEX_SETTINGS.has(e.key[0] ?? ''))) {
    return false
  }
  const indexes = new Map<number, { url: unknown; explicit: unknown }>()
  for (const entry of entriesUnder(entries, 'tool.uv.index')) {
    const index = indexes.get(entry.tableIndex) ?? { url: null, explicit: false }
    if (entry.key.join('.') === 'url') index.url = scalarValue(text, entry)
    if (entry.key.join('.') === 'explicit') index.explicit = scalarValue(text, entry)
    indexes.set(entry.tableIndex, index)
  }
  for (const { url, explicit } of indexes.values()) {
    if (explicit !== true && !PYPI_INDEXES.has(typeof url === 'string' ? url : '')) return false
  }
  const wanted = normalizePypiName(name)
  return !entries.some(
    (entry) =>
      (entry.table.join('.') === 'tool.uv.sources' &&
        normalizePypiName(entry.key[0] ?? '') === wanted) ||
      (entry.table.length === 4 &&
        entry.table.slice(0, 3).join('.') === 'tool.uv.sources' &&
        normalizePypiName(entry.table[3] ?? '') === wanted),
  )
}

function checkStep(step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'lockfile_update' || apply.tool !== 'uv') {
    return Promise.resolve({
      status: 'failed',
      reason: 'edit_failed',
      detail: `${apply.type} is not a uv lock update`,
    })
  }
  return Promise.resolve({ status: 'edited', files: [] })
}

export const uvApplier: Applier = {
  packageManager: 'uv',
  lockfiles: ['uv.lock'],
  versionCommand: { file: 'uv', args: ['--version'] },

  async resolvedVersions(ctx, name) {
    return [...new Set((await lockedPackages(ctx, name)).map((pkg) => pkg.version))]
  },

  // uv's exclude-newer is a cut off date, not an age; Hinomi's floor applies, and a repo cut
  // off newer than `to` makes the lock fail on its own.
  releaseAgeGate: () => Promise.resolve(null),

  async publishedAt(ctx, name, version) {
    const locked = await lockedPackages(ctx, name)
    // A package from another index has no PyPI publish time to trust.
    if (locked.length === 0 || !locked.every((pkg) => PYPI_INDEXES.has(pkg.registry ?? ''))) {
      return null
    }
    // Where the lock step would fetch it from now, not only where it came from before.
    if (!(await sourceIsPypi(ctx.fs, ctx.root, name))) return null
    return ctx.publishTimes.publishedAt(normalizePypiName(name), version, PYPI_API)
  },

  applyStep: (_ctx, step) => checkStep(step),

  lockfileInstall(ctx, { steps }) {
    return (
      uvLockCommand(steps, uvEnv(ctx.fs.root, runnerPython(ctx.fs.root, ctx.searchPath ?? ''))) ??
      []
    )
  },

  // Checks the lockfile matches the project without building or installing anything.
  fullInstall(ctx) {
    return {
      file: 'uv',
      args: ['lock', '--check', '--no-build'],
      env: uvEnv(ctx.fs.root, runnerPython(ctx.fs.root, ctx.searchPath ?? '')),
    }
  },

  checks: () => Promise.resolve([]),
}
