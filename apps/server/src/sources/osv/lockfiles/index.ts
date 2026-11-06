import type { LockfileDependency } from '@hinomi/shared'
import { parseBunLock } from './bun.js'
import { parseCargoLock } from './cargo.js'
import { parsePackageLock } from './npm.js'
import { parsePnpmLock } from './pnpm.js'
import { parseYarnLock } from './yarn.js'

export { dedupeDependencies } from './graph.js'
export { parseBunLock, parseCargoLock, parsePackageLock, parsePnpmLock, parseYarnLock }

/** Lockfile names Hinomi can read, in order of preference when a folder has several. */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
] as const

export type LockfileName = (typeof LOCKFILE_NAMES)[number]

export class UnsupportedLockfileError extends Error {
  constructor(filename: string) {
    super(`unsupported lockfile: ${filename}`)
    this.name = 'UnsupportedLockfileError'
  }
}

export interface ParseLockfileOptions {
  /** package.json next to the lockfile; lets yarn.lock tell runtime from dev. */
  packageJson?: string
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function isLockfileName(name: string): name is LockfileName {
  return (LOCKFILE_NAMES as readonly string[]).includes(name)
}

/** Parses a lockfile by its file name (a path is fine) into deduped dependencies. */
export function parseLockfile(
  text: string,
  filename: string,
  options: ParseLockfileOptions = {},
): LockfileDependency[] {
  const name = basename(filename)
  switch (name) {
    case 'pnpm-lock.yaml':
      return parsePnpmLock(text)
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parsePackageLock(text)
    case 'yarn.lock':
      return parseYarnLock(text, options.packageJson)
    case 'bun.lock':
      return parseBunLock(text)
    case 'Cargo.lock':
      return parseCargoLock(text)
    default:
      throw new UnsupportedLockfileError(name)
  }
}
