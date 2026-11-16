import type { FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { PYPI_API } from '../registry.js'
import { scalarValue, scanInlineTable, scanToml } from '../toml.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// uv with uv.lock. A step is a lockfile_update: `uv lock --no-build --upgrade-package
// <name>==<to>` re-resolves only that package and writes uv.lock; nothing is installed and
// pyproject.toml is not edited, so a requirement whose range excludes `to` makes the lock fail
// and the step is reported as install_failed. `--no-build` is what keeps package code out:
// without it uv builds source distributions to read their metadata, which runs their setup
// code. With it uv takes metadata only from wheels and static source metadata, and a package
// that would need a build fails the lock instead.

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

/** The single `uv lock` for the steps of one attempt, null when there is nothing to move. */
export function uvLockCommand(steps: readonly FixDispatchStep[]): Command | null {
  const upgrades = steps.flatMap(({ apply }) =>
    apply.type === 'lockfile_update'
      ? ['--upgrade-package', `${apply.packageName}==${apply.to}`]
      : [],
  )
  if (upgrades.length === 0) return null
  return { file: 'uv', args: ['lock', '--no-build', ...upgrades] }
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
    return ctx.publishTimes.publishedAt(normalizePypiName(name), version, PYPI_API)
  },

  applyStep: (_ctx, step) => checkStep(step),

  lockfileInstall(_ctx, { steps }) {
    return uvLockCommand(steps) ?? []
  },

  // Checks the lockfile matches the project without building or installing anything.
  fullInstall() {
    return { file: 'uv', args: ['lock', '--check', '--no-build'] }
  },

  checks: () => Promise.resolve([]),
}
