import { createHash } from 'node:crypto'
import { isSafeRepoPath } from '@hinomi/shared'
import type { Git } from './git.js'

// The patch the publish job applies. Only dependency files go in: anything else an install
// or a tool touched stays out (and is logged), so the fix PR can never carry source,
// workflow or script changes.

/** File names a fix may change anywhere in the repo. */
export const DEPENDENCY_FILE_NAMES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.toml',
  'Cargo.lock',
]

/** Config files a fix may change only when an applied step reported editing that exact path. */
export const STEP_ONLY_FILE_NAMES: readonly string[] = ['.npmrc', '.yarnrc.yml']

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * True when `path` may be in the patch: a safe repo path outside `.github` and
 * `node_modules`, named like a dependency file, or a step only config file that a step edited.
 */
export function isAllowedPatchPath(path: string, stepFiles: ReadonlySet<string>): boolean {
  if (path === '.' || !isSafeRepoPath(path)) return false
  if (path.split('/').includes('node_modules')) return false
  const name = basename(path)
  if (DEPENDENCY_FILE_NAMES.includes(name)) return true
  return STEP_ONLY_FILE_NAMES.includes(name) && stepFiles.has(path)
}

export interface CapturedPatch {
  /** `git diff --binary` of the allowed files, null when nothing allowed changed. */
  text: string | null
  files: string[]
  insertions: number
  deletions: number
  sha256: string | null
  /** Changed files left out of the patch. */
  ignored: string[]
}

/** Captures the patch of the allowed changed files against HEAD. */
export async function capturePatch(
  git: Git,
  stepFiles: ReadonlySet<string>,
): Promise<CapturedPatch> {
  const changed = await git.changedFiles()
  const files = changed.filter((path) => isAllowedPatchPath(path, stepFiles)).sort()
  const ignored = changed.filter((path) => !files.includes(path))
  if (files.length === 0) {
    return { text: null, files, insertions: 0, deletions: 0, sha256: null, ignored }
  }
  const diffArgs = [
    'diff',
    '--binary',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
  ]
  const text = await git.run([...diffArgs, 'HEAD', '--', ...files])
  const stat = await git.run(['diff', '--numstat', '--no-renames', 'HEAD', '--', ...files])
  let insertions = 0
  let deletions = 0
  for (const line of stat.split('\n')) {
    const [added, removed] = line.split('\t')
    insertions += Number(added) || 0
    deletions += Number(removed) || 0
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  return { text, files, insertions, deletions, sha256, ignored }
}
