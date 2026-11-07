import type { RepoFs } from './repo-fs.js'
import { repoJoin } from './repo-fs.js'
import { isJsonObject, parseJsonFile } from './json-file.js'
import type { StepPackageManager } from './appliers/index.js'

// Package manager detection from the checkout: the lockfiles in a project folder plus the
// `packageManager` field. The runner compares the answer with the dispatch and stops on a
// mismatch; it never guesses.

/** Lockfile names and the package manager each one means, every manager Hinomi plans for. */
export const KNOWN_LOCKFILES: ReadonlyArray<readonly [string, StepPackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['Cargo.lock', 'cargo'],
]

export interface DeclaredPackageManager {
  name: string
  /** Version without the `+sha...` hash, null when the field has none. */
  version: string | null
}

/** Parses a `packageManager` field such as `pnpm@10.34.9+sha512.abc`. */
export function parsePackageManagerField(value: unknown): DeclaredPackageManager | null {
  if (typeof value !== 'string') return null
  const match = /^(@?[a-z0-9._-]+)(?:@([^+\s]+))?/.exec(value.trim())
  if (!match?.[1]) return null
  return { name: match[1], version: match[2] ?? null }
}

export interface DetectedProject {
  packageManager: StepPackageManager
  /** Repo relative lockfile path. */
  lockfile: string
  /** From the `packageManager` field, when it names this manager. */
  declaredVersion: string | null
}

export type Detection = { ok: true; project: DetectedProject } | { ok: false; problem: string }

async function declaredIn(fs: RepoFs, root: string): Promise<DeclaredPackageManager | null> {
  for (const folder of [...new Set([root, '.'])]) {
    const text = await fs.read(repoJoin(folder, 'package.json'))
    if (text === null) continue
    try {
      const { data } = parseJsonFile(text)
      if (isJsonObject(data) && data.packageManager !== undefined) {
        return parsePackageManagerField(data.packageManager)
      }
    } catch {
      return null
    }
  }
  return null
}

/** Detects the package manager of the project in `root` (repo relative folder). */
export async function detectProject(fs: RepoFs, root: string): Promise<Detection> {
  const found: Array<{ lockfile: string; manager: StepPackageManager }> = []
  for (const [name, manager] of KNOWN_LOCKFILES) {
    const lockfile = repoJoin(root, name)
    if (await fs.exists(lockfile)) found.push({ lockfile, manager })
  }
  const declared = await declaredIn(fs, root)
  const managers = [...new Set(found.map((entry) => entry.manager))]
  if (managers.length === 0) return { ok: false, problem: `no lockfile in ${root}` }

  let manager: StepPackageManager
  if (managers.length === 1 && managers[0]) {
    manager = managers[0]
  } else if (declared && managers.includes(declared.name as StepPackageManager)) {
    manager = declared.name as StepPackageManager
  } else {
    return { ok: false, problem: `several lockfiles in ${root}: ${managers.join(', ')}` }
  }
  if (declared && declared.name !== manager && manager !== 'cargo') {
    return {
      ok: false,
      problem: `packageManager says ${declared.name} but the lockfile is ${manager}'s`,
    }
  }
  const lockfile = found.find((entry) => entry.manager === manager)?.lockfile ?? ''
  return {
    ok: true,
    project: {
      packageManager: manager,
      lockfile,
      declaredVersion: declared?.name === manager ? declared.version : null,
    },
  }
}
