import type { FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { isJsonObject, parseJsonFile } from '../json-file.js'
import { PACKAGIST_API } from '../registry.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// Composer with composer.lock. A step is a lockfile_update: one `composer update` with the
// partial update syntax `<vendor/package>:<to>` for every step, `--minimal-changes` so other
// packages stay where they are, and `--no-install`, so only composer.lock is written and no
// package is downloaded or installed. `--no-scripts` keeps the root composer.json scripts (and
// every package script) from running and `--no-plugins` keeps plugins from loading, so no
// package code runs. composer.json is not edited: a root requirement whose range excludes
// `to` makes the update fail, and the step is reported as install_failed.

/** Flags of every composer command the runner starts. */
export const COMPOSER_SAFE_FLAGS = [
  '--no-scripts',
  '--no-plugins',
  '--no-interaction',
  '--no-progress',
  '--no-audit',
  // PHP extensions only matter at run time; the runner's PHP lacking one must not block a
  // lockfile update. The php version itself is still checked.
  '--ignore-platform-req=ext-*',
] as const

/** composer.lock records packages from Packagist with this notification URL. */
const PACKAGIST_NOTIFY = 'https://packagist.org/downloads/'

export interface LockedComposerPackage {
  /** Lowercase `vendor/package`. */
  name: string
  /** Without a leading `v`, as Hinomi stores Packagist versions. */
  version: string
  fromPackagist: boolean
}

/** Every package of a composer.lock, `packages` and `packages-dev`. */
export function composerLockPackages(text: string): LockedComposerPackage[] {
  const { data } = parseJsonFile(text)
  if (!isJsonObject(data)) return []
  const out: LockedComposerPackage[] = []
  for (const key of ['packages', 'packages-dev']) {
    const list = data[key]
    if (!Array.isArray(list)) continue
    for (const pkg of list) {
      if (!isJsonObject(pkg) || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
        continue
      }
      out.push({
        name: pkg.name.toLowerCase(),
        version: pkg.version.trim().replace(/^v(?=\d)/i, ''),
        fromPackagist: pkg['notification-url'] === PACKAGIST_NOTIFY,
      })
    }
  }
  return out
}

async function lockedPackages(ctx: ProjectContext, name: string): Promise<LockedComposerPackage[]> {
  const text = await ctx.fs.read(ctx.lockfile)
  if (text === null) return []
  try {
    const wanted = name.toLowerCase()
    return composerLockPackages(text).filter((pkg) => pkg.name === wanted)
  } catch {
    return []
  }
}

/** The single `composer update` for the steps of one attempt, null when there is none. */
export function composerUpdateCommand(steps: readonly FixDispatchStep[]): Command | null {
  const targets = steps.flatMap(({ apply }) =>
    apply.type === 'lockfile_update' ? [`${apply.packageName}:${apply.to}`] : [],
  )
  if (targets.length === 0) return null
  return {
    file: 'composer',
    args: ['update', ...targets, '--no-install', '--minimal-changes', ...COMPOSER_SAFE_FLAGS],
  }
}

function checkStep(step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'lockfile_update' || apply.tool !== 'composer') {
    return Promise.resolve({
      status: 'failed',
      reason: 'edit_failed',
      detail: `${apply.type} is not a composer update`,
    })
  }
  return Promise.resolve({ status: 'edited', files: [] })
}

export const composerApplier: Applier = {
  packageManager: 'composer',
  lockfiles: ['composer.lock'],
  versionCommand: { file: 'composer', args: ['--version', '--no-plugins', '--no-interaction'] },
  // It also prints the PHP version and a hint about `composer diagnose`.
  versionLine: (lines) => lines.find((line) => line.startsWith('Composer version')),

  async resolvedVersions(ctx, name) {
    return [...new Set((await lockedPackages(ctx, name)).map((pkg) => pkg.version))]
  },

  // Hinomi's floor applies; a cooldown the repo sets in composer.json is enforced by composer
  // itself during the update and the runner never turns it off.
  releaseAgeGate: () => Promise.resolve(null),

  async publishedAt(ctx, name, version) {
    const locked = await lockedPackages(ctx, name)
    // A package from another repository has no Packagist publish time to trust.
    if (locked.length === 0 || !locked.every((pkg) => pkg.fromPackagist)) return null
    return ctx.publishTimes.publishedAt(name.toLowerCase(), version, PACKAGIST_API)
  },

  applyStep: (_ctx, step) => checkStep(step),

  lockfileInstall(_ctx, { steps }) {
    return composerUpdateCommand(steps) ?? []
  },

  // Downloads and installs the locked packages without running any script or plugin.
  fullInstall() {
    return { file: 'composer', args: ['install', ...COMPOSER_SAFE_FLAGS] }
  },

  checks: () => Promise.resolve([]),
}
