import { lstatSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FixDispatchStep } from '@hinomi/shared'
import type { Command } from '../exec.js'
import { isJsonObject, parseJsonFile } from '../json-file.js'
import { PACKAGIST_API } from '../registry.js'
import { repoJoin, type RepoFs } from '../repo-fs.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// Composer with composer.lock. A step is a lockfile_update: one `composer update` with the
// partial update syntax `<vendor/package>:<to>` for every step, `--minimal-changes` so other
// packages stay where they are, and `--no-install`, so only composer.lock is written and no
// package is downloaded or installed. `--no-scripts` keeps the root composer.json scripts (and
// every package script) from running and `--no-plugins` keeps plugins from loading, so no
// package code runs. composer.json is not edited: a root requirement whose range excludes
// `to` makes the update fail, and the step is reported as install_failed.

/** Flags of every composer command the runner starts (install has no `--no-audit`). */
export const COMPOSER_SAFE_FLAGS = [
  '--no-scripts',
  '--no-plugins',
  '--no-interaction',
  '--no-progress',
  // PHP extensions only matter at run time; the runner's PHP lacking one must not block a
  // lockfile update. The php version itself is still checked.
  '--ignore-platform-req=ext-*',
] as const

/**
 * Environment of every composer command: no audit (update audits by default and would call
 * out to Packagist's advisories), and the vendor and bin folders where composer puts them by
 * default, so a composer.json `config.vendor-dir` cannot send the install outside the checkout.
 */
export const COMPOSER_ENV: Readonly<Record<string, string>> = {
  COMPOSER_NO_AUDIT: '1',
  COMPOSER_VENDOR_DIR: 'vendor',
  COMPOSER_BIN_DIR: 'vendor/bin',
}

let cache: string | null = null

/**
 * COMPOSER_ENV plus a cache folder of this runner process, outside every checkout, so a
 * composer.json `config.cache-dir` cannot point the downloads at a folder of its choosing.
 */
export function composerEnv(): Record<string, string> {
  cache ??= mkdtempSync(join(tmpdir(), 'hinomi-composer-'))
  return { ...COMPOSER_ENV, COMPOSER_CACHE_DIR: cache }
}

/** How deep under vendor a committed symlink is looked for (vendor/<vendor>/<package>). */
const VENDOR_DEPTH = 2

/**
 * The first committed symlink composer install would write through: vendor or vendor/bin
 * themselves, or an entry under vendor down to a package folder. Null when there is none.
 */
export function vendorSymlink(fs: RepoFs, root: string): string | null {
  const isLink = (path: string) => {
    try {
      return lstatSync(fs.absolute(path)).isSymbolicLink()
    } catch {
      return false
    }
  }
  const vendor = repoJoin(root, COMPOSER_ENV.COMPOSER_VENDOR_DIR ?? 'vendor')
  const bin = repoJoin(root, COMPOSER_ENV.COMPOSER_BIN_DIR ?? 'vendor/bin')
  for (const path of [vendor, bin]) if (isLink(path)) return path
  let level = [vendor]
  for (let depth = 0; depth < VENDOR_DEPTH; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let names: string[]
      try {
        names = readdirSync(fs.absolute(dir))
      } catch {
        continue
      }
      for (const name of names) {
        const path = repoJoin(dir, name)
        if (isLink(path)) return path
        next.push(path)
      }
    }
    level = next
  }
  return null
}

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

/**
 * Whether the project's composer.json leaves Packagist as the only repository. Any entry under
 * `repositories` (a vcs, path, package or composer repository, or Packagist turned off) can
 * serve the package instead, whatever the lockfile recorded before.
 */
export async function onlyPackagist(ctx: ProjectContext): Promise<boolean> {
  const text = await ctx.fs.read(repoJoin(ctx.root, 'composer.json'))
  if (text === null) return false
  try {
    const { data } = parseJsonFile(text)
    if (!isJsonObject(data)) return false
    const repositories = data.repositories
    if (repositories === undefined) return true
    if (Array.isArray(repositories)) return repositories.length === 0
    return isJsonObject(repositories) && Object.keys(repositories).length === 0
  } catch {
    return false
  }
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
    args: [
      'update',
      ...targets,
      '--no-install',
      '--minimal-changes',
      '--no-audit',
      ...COMPOSER_SAFE_FLAGS,
    ],
    env: composerEnv(),
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
    // Where the update would fetch it from now, not only where it came from before.
    if (!(await onlyPackagist(ctx))) return null
    return ctx.publishTimes.publishedAt(name.toLowerCase(), version, PACKAGIST_API)
  },

  applyStep: (_ctx, step) => checkStep(step),

  lockfileInstall(_ctx, { steps }) {
    return composerUpdateCommand(steps) ?? []
  },

  // Downloads and installs the locked packages without running any script or plugin, and not
  // through a committed symlink that would send the files outside the checkout.
  fullInstall(ctx) {
    const link = vendorSymlink(ctx.fs, ctx.root)
    if (link) {
      return { refused: `${link} is a symlink, so composer install could write outside the repo` }
    }
    return { file: 'composer', args: ['install', ...COMPOSER_SAFE_FLAGS], env: composerEnv() }
  },

  checks: () => Promise.resolve([]),
}
