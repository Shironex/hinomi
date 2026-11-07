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

// ---------------------------------------------------------------------------
// The majors patch: source changes a coding agent made, on their own branch. Wider than the
// dependency allowlist by necessity, so it is held to limits instead: no workflow, hook, CI,
// editor, agent or registry configuration, no node_modules or vendored tool code, only added or
// modified regular files, no binary data, and a cap on files and bytes.

/** Most files a majors patch may change. */
export const MAJORS_PATCH_MAX_FILES = 200
/** Most bytes a majors patch may have. */
export const MAJORS_PATCH_MAX_BYTES = 1_000_000

/** Folders a majors patch never touches, at any depth. */
const MAJORS_REFUSED_DIRS = new Set([
  'node_modules',
  '.git',
  '.husky',
  '.devcontainer',
  '.claude',
  '.vscode',
  '.idea',
  '.hinomi',
  '.yarn',
  '.cargo',
  '.circleci',
  '.buildkite',
  '.gitlab',
])

/** File names a majors patch never touches: hooks, CI, agent and registry configuration. */
const MAJORS_REFUSED_FILES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  '.gitmodules',
  '.gitattributes',
  '.mcp.json',
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook-local.yml',
  '.pre-commit-config.yaml',
  '.gitlab-ci.yml',
  'CLAUDE.md',
  'AGENTS.md',
])

/**
 * True when a majors patch may carry `path`: a safe repo path (inside the repo, outside
 * `.github`, no whitespace) away from the refused folders and files and `.env` files.
 */
export function isAllowedMajorsPatchPath(path: string): boolean {
  if (path === '.' || !isSafeRepoPath(path)) return false
  const segments = path.split('/')
  if (segments.some((segment) => MAJORS_REFUSED_DIRS.has(segment))) return false
  const name = basename(path)
  if (MAJORS_REFUSED_FILES.has(name)) return false
  return name !== '.env' && !name.startsWith('.env.')
}

export type MajorsPatch =
  | {
      kind: 'patch'
      /** Null when nothing allowed changed. */
      patch: CapturedPatch
      /** Changed paths left out: refused by the allowlist, binary, deleted, links, re-moded. */
      refused: string[]
    }
  /** The allowed changes break a limit; nothing may be published. */
  | { kind: 'over_limit'; detail: string; refused: string[] }

const REGULAR_FILE_MODES = new Set(['100644', '100755'])

interface RawEntry {
  path: string
  status: string
  newMode: string
}

/** Parses `git diff --raw -z`: `:old new oldsha newsha status\0path\0`, renames off. */
function parseRaw(raw: string): RawEntry[] {
  const parts = raw.split('\0')
  const entries: RawEntry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? ''
    const path = parts[i + 1] ?? ''
    const fields = meta.replace(/^:/, '').split(' ')
    entries.push({ path, newMode: fields[1] ?? '', status: fields[4] ?? '' })
  }
  return entries.filter((entry) => entry.path !== '')
}

/**
 * Captures what the agent changed against the base commit, untracked files included (the
 * repo's .gitignore applies): stages everything, keeps added and modified regular text files
 * the majors allowlist accepts, and refuses the whole patch over the file or byte cap.
 */
export async function captureMajorsPatch(git: Git, baseSha: string): Promise<MajorsPatch> {
  await git.run(['add', '--all', '--', '.'])
  const base = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv']
  const entries = parseRaw(await git.run([...base, '--raw', '-z', baseSha]))
  const numstat = await git.run([...base, '--numstat', '-z', baseSha])
  const binary = new Set(
    numstat
      .split('\0')
      .filter((line) => line.startsWith('-\t-\t'))
      .map((line) => line.slice(4)),
  )
  const kept: string[] = []
  const refused: string[] = []
  for (const entry of entries) {
    const ok =
      (entry.status === 'A' || entry.status === 'M') &&
      REGULAR_FILE_MODES.has(entry.newMode) &&
      !binary.has(entry.path) &&
      isAllowedMajorsPatchPath(entry.path)
    ;(ok ? kept : refused).push(entry.path)
  }
  kept.sort()
  refused.sort()
  const empty: CapturedPatch = {
    text: null,
    files: [],
    insertions: 0,
    deletions: 0,
    sha256: null,
    ignored: refused,
  }
  if (kept.length === 0) return { kind: 'patch', patch: empty, refused }
  if (kept.length > MAJORS_PATCH_MAX_FILES) {
    const detail = `the agent changed ${kept.length} files, more than the ${MAJORS_PATCH_MAX_FILES} a majors patch may carry`
    return { kind: 'over_limit', detail, refused }
  }
  const text = await git.run([...base, '--no-color', baseSha, '--', ...kept])
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAJORS_PATCH_MAX_BYTES) {
    const detail = `the agent's patch is ${bytes} bytes, more than the ${MAJORS_PATCH_MAX_BYTES} a majors patch may carry`
    return { kind: 'over_limit', detail, refused }
  }
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\0')) {
    const [added, removed, path] = line.split('\t')
    if (path === undefined || !kept.includes(path)) continue
    insertions += Number(added) || 0
    deletions += Number(removed) || 0
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  return {
    kind: 'patch',
    patch: { text, files: kept, insertions, deletions, sha256, ignored: refused },
    refused,
  }
}
