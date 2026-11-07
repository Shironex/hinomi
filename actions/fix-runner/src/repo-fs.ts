import { access, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isSafeRepoPath } from '@hinomi/shared'
import { FixRunnerError } from './errors.js'

/** File access limited to the checkout: every path is repo relative and checked first. */
export interface RepoFs {
  /** Absolute path of the checkout. */
  readonly root: string
  /** Absolute path of a repo relative path. */
  absolute(path: string): string
  exists(path: string): Promise<boolean>
  /** The file's text, null when it does not exist. */
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
  /** Raw bytes, for snapshots of files that may be binary (bun.lockb). Null when missing. */
  readBytes(path: string): Promise<Buffer | null>
  writeBytes(path: string, bytes: Buffer): Promise<void>
}

/** Joins repo relative segments into a normalized repo relative path (`.` for the root). */
export function repoJoin(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
  return joined === '' ? '.' : joined
}

/** The folder of a repo relative path, `.` for a file at the root. */
export function repoDirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '.' : path.slice(0, index)
}

export function nodeRepoFs(root: string): RepoFs {
  const base = resolve(root)
  const absolute = (path: string) => {
    if (!isSafeRepoPath(path)) throw new FixRunnerError(`Refusing path outside the repo: ${path}`)
    const full = resolve(base, path)
    const rel = relative(base, full)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new FixRunnerError(`Refusing path outside the repo: ${path}`)
    }
    return path === '.' ? base : join(base, rel)
  }
  // A symlink inside the checkout could point anywhere; edits only follow ones that stay in.
  const contained = async (path: string) => {
    const full = absolute(path)
    let real: string
    try {
      real = await realpath(full)
    } catch {
      return full
    }
    const rel = relative(await realpath(base), real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new FixRunnerError(`Refusing a symlink that leaves the repo: ${path}`)
    }
    return full
  }
  return {
    root: base,
    absolute,
    async exists(path) {
      try {
        await access(absolute(path))
        return true
      } catch {
        return false
      }
    },
    async read(path) {
      try {
        return await readFile(await contained(path), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(path, text) {
      await writeFile(await contained(path), text, 'utf8')
    },
    async readBytes(path) {
      try {
        return await readFile(await contained(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async writeBytes(path, bytes) {
      await writeFile(await contained(path), bytes)
    },
  }
}
