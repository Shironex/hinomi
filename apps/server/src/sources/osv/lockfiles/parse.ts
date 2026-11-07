import type { LockfileDependency } from '@hinomi/shared'
import { parseBunLock } from './bun.js'
import { parseCargoLock } from './cargo.js'
import { parsePackageLock } from './npm.js'
import { parsePnpmLock } from './pnpm.js'
import { parseYarnLock } from './yarn.js'

/** Lockfile names Hinomi can read, in order of preference when a folder has several. */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'composer.lock',
  'Gemfile.lock',
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

type LockfileParser = (text: string, options: ParseLockfileOptions) => LockfileDependency[]

/**
 * One entry per lockfile name that has a parser. A name in `LOCKFILE_NAMES` without an entry
 * (go.sum, and formats whose parser has not landed yet) is fetched but skipped without an error.
 * A parser slice adds its names here.
 */
const PARSERS: Partial<Record<LockfileName, LockfileParser>> = {
  'pnpm-lock.yaml': (text) => parsePnpmLock(text),
  'package-lock.json': (text) => parsePackageLock(text),
  'npm-shrinkwrap.json': (text) => parsePackageLock(text),
  'yarn.lock': (text, options) => parseYarnLock(text, options.packageJson),
  'bun.lock': (text) => parseBunLock(text),
  'Cargo.lock': (text) => parseCargoLock(text),
}

/** Whether `parseLockfile` can read a file of this name (a path is fine). */
export function hasLockfileParser(filename: string): boolean {
  const name = basename(filename)
  return isLockfileName(name) && PARSERS[name] !== undefined
}

/** Parses a lockfile by its file name (a path is fine) into deduped dependencies. */
export function parseLockfile(
  text: string,
  filename: string,
  options: ParseLockfileOptions = {},
): LockfileDependency[] {
  const name = basename(filename)
  const parser = isLockfileName(name) ? PARSERS[name] : undefined
  if (!parser) throw new UnsupportedLockfileError(name)
  return parser(text, options)
}
