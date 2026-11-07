import { FixRunnerError } from './errors.js'
import type { Exec } from './exec.js'
import type { RepoFs } from './repo-fs.js'

// The few git operations the apply job needs, through the Exec boundary. Paths go after `--`
// so a file name can never be read as an option.

const GIT_TIMEOUT_MS = 120_000

export interface Git {
  /** Runs git with `args` in the checkout and returns stdout; throws on a non zero exit. */
  run(args: string[]): Promise<string>
  headSha(): Promise<string>
  /** Tracked files that differ from HEAD (staged or not), repo relative. */
  changedFiles(): Promise<string[]>
  /** Puts these files back to their HEAD content. */
  checkoutHead(paths: string[]): Promise<void>
}

export function createGit(exec: Exec, root: string): Git {
  const run = async (args: string[]) => {
    const result = await exec.run(
      { file: 'git', args: ['-c', 'core.quotepath=off', '--no-pager', ...args] },
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    )
    if (result.code !== 0) {
      throw new FixRunnerError(`git ${args[0] ?? ''} failed: ${result.output.trim().slice(-500)}`)
    }
    return result.output
  }
  return {
    run,
    async headSha() {
      return (await run(['rev-parse', 'HEAD'])).trim()
    },
    async changedFiles() {
      const out = await run(['diff', '--name-only', '-z', '--no-renames', 'HEAD'])
      return out.split('\0').filter((path) => path !== '')
    },
    async checkoutHead(paths) {
      if (paths.length > 0) await run(['checkout', 'HEAD', '--', ...paths])
    },
  }
}

/** The tree's changed files and their bytes at one moment, to come back to during bisect. */
export interface Snapshot {
  restore(): Promise<void>
}

export async function takeSnapshot(git: Git, fs: RepoFs): Promise<Snapshot> {
  const saved = new Map<string, Buffer | null>()
  for (const path of await git.changedFiles()) saved.set(path, await fs.readBytes(path))
  return {
    async restore() {
      const changed = await git.changedFiles()
      await git.checkoutHead(changed.filter((path) => !saved.has(path)))
      for (const [path, bytes] of saved) {
        if (bytes !== null) await fs.writeBytes(path, bytes)
      }
    },
  }
}
