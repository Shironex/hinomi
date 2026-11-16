import { readdirSync } from 'node:fs'
import { posix } from 'node:path'
import { repoDirname, repoJoin, type RepoFs } from '../repo-fs.js'
import { scanToml, scalarValue, type TomlEntry } from '../toml.js'

// What a uv project is made of, and whether `uv lock --no-build` can lock it without running
// any of its code. `--no-build` only stops uv from building packages it downloads: the project
// itself, its workspace members and its path (or editable) sources are still asked for their
// metadata, and when that metadata is not static uv runs their PEP 517 backend for it (an
// in-tree backend-path, or hatchling from PyPI with a hatch_build.py hook). So every one of
// those pyproject.toml files must carry a static [project] name and version and no `dynamic`
// fields, or Hinomi does not touch the lockfile. Git and URL sources, and direct URL
// requirements, would be built too, and are refused the same way.

/** One pyproject.toml of the project, parsed. */
export interface UvProjectFile {
  /** Repo relative path of the pyproject.toml. */
  path: string
  text: string
  entries: TomlEntry[]
}

export type UvProject = { ok: true; files: UvProjectFile[] } | { ok: false; problem: string }

/** Most pyproject.toml files followed before the project is given up on. */
const MAX_FILES = 200

/** Tables whose arrays hold PEP 508 requirements. */
const REQUIREMENT_TABLES = new Set([
  'project.dependencies',
  'project.optional-dependencies',
  'dependency-groups',
  'tool.uv.dev-dependencies',
  'tool.uv.override-dependencies',
  'tool.uv.constraint-dependencies',
])

/** Tables whose every key is a named list of requirements. */
const GROUP_TABLES = ['project.optional-dependencies', 'dependency-groups']

/** The quoted strings of a TOML array (single line strings, which requirements are). */
function arrayStrings(raw: string): string[] {
  const out: string[] = []
  for (const match of raw.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    out.push(match[1] ?? match[2] ?? '')
  }
  return out
}

/** `name @ url`: a requirement uv fetches from a URL, which it would build. */
export function isDirectUrlRequirement(requirement: string): boolean {
  return /^\s*[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[[^\]]*\])?\s*@/.test(requirement)
}

/** The requirement strings of a pyproject.toml, from every table that holds them. */
export function requirementsOf(file: UvProjectFile): string[] {
  return file.entries.flatMap((entry) => {
    const table = entry.table.join('.')
    const full = [...entry.table, ...entry.key].join('.')
    const inTable =
      REQUIREMENT_TABLES.has(full) ||
      GROUP_TABLES.some((group) => table === group || full.startsWith(`${group}.`))
    return inTable ? arrayStrings(file.text.slice(entry.start, entry.end)) : []
  })
}

/** The [tool.uv.sources] of a file: package (as written) and the raw source value. */
export function sourcesOf(file: UvProjectFile): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = []
  for (const entry of file.entries) {
    const table = entry.table.join('.')
    if (table === 'tool.uv.sources' && entry.key[0]) {
      out.push({ name: entry.key[0], raw: file.text.slice(entry.start, entry.end) })
    } else if (
      entry.table.length === 4 &&
      entry.table.slice(0, 3).join('.') === 'tool.uv.sources' &&
      entry.table[3]
    ) {
      // [tool.uv.sources.<name>] path = "..."
      const field = entry.key.join('.')
      out.push({
        name: entry.table[3],
        raw: `{ ${field} = ${file.text.slice(entry.start, entry.end)} }`,
      })
    }
  }
  return out
}

function stringField(raw: string, field: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(`(?:^|[{,\\s])${field}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')`, 'g')
  for (const match of raw.matchAll(pattern)) out.push(match[1] ?? match[2] ?? '')
  return out
}

/** Why a pyproject.toml's metadata would need its build backend, null when it is static. */
function dynamicProblem(file: UvProjectFile, virtualAllowed: boolean): string | null {
  const project = file.entries.filter((e) => e.table[0] === 'project' && e.table.length === 1)
  const nested =
    file.entries.some((e) => e.table[0] === 'project') || /^\s*\[\s*project\s*\]/m.test(file.text)
  if (!nested) {
    return virtualAllowed ? null : `${file.path} has no [project] table, so uv would build it`
  }
  const field = (name: string) => project.find((e) => e.key.join('.') === name)
  const dynamic = field('dynamic')
  if (dynamic && !/^\[\s*\]$/.test(file.text.slice(dynamic.start, dynamic.end).trim())) {
    return `${file.path} declares dynamic metadata, which uv gets by running its build backend`
  }
  for (const name of ['name', 'version']) {
    const entry = field(name)
    if (!entry || typeof scalarValue(file.text, entry) !== 'string') {
      return `${file.path} has no static project ${name}, which uv gets by running its build backend`
    }
  }
  return null
}

/** Directories of the repo matching one workspace glob, null for a pattern Hinomi will not expand. */
function expandMembers(fs: RepoFs, root: string, pattern: string): string[] | null {
  if (!/^[A-Za-z0-9._*/-]+$/.test(pattern) || pattern.includes('**')) return null
  let dirs = [root]
  for (const segment of pattern.split('/').filter((part) => part !== '' && part !== '.')) {
    if (segment === '..') return null
    if (!segment.includes('*')) {
      dirs = dirs.map((dir) => repoJoin(dir, segment))
      continue
    }
    const match = new RegExp(`^${segment.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`)
    dirs = dirs.flatMap((dir) => {
      try {
        return readdirSync(fs.absolute(dir), { withFileTypes: true })
          .filter((item) => item.isDirectory() && match.test(item.name))
          .map((item) => repoJoin(dir, item.name))
      } catch {
        return []
      }
    })
  }
  return dirs
}

/**
 * Every pyproject.toml uv would read metadata from when it locks the project at `root`: the
 * root, its workspace members and the directories its path sources name (followed through
 * their own sources). Fails with the reason when any of them would need a build backend, or
 * when the project uses a git or URL source, a direct URL requirement or a workspace glob
 * Hinomi does not expand.
 */
export async function readUvProject(fs: RepoFs, root: string): Promise<UvProject> {
  const files: UvProjectFile[] = []
  const queue: { path: string; virtualAllowed: boolean; members: boolean }[] = [
    { path: repoJoin(root, 'pyproject.toml'), virtualAllowed: true, members: true },
  ]
  const seen = new Set<string>()
  const fail = (problem: string): UvProject => ({ ok: false, problem })
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || seen.has(next.path)) continue
    seen.add(next.path)
    if (seen.size > MAX_FILES) return fail(`more than ${MAX_FILES} pyproject.toml files`)
    const text = await fs.read(next.path).catch(() => null)
    if (text === null) {
      return fail(`${repoDirname(next.path)} has no pyproject.toml, so uv would build it`)
    }
    let entries: TomlEntry[]
    try {
      entries = scanToml(text)
    } catch {
      return fail(`${next.path} could not be read`)
    }
    const file = { path: next.path, text, entries }
    const problem = dynamicProblem(file, next.virtualAllowed)
    if (problem) return fail(problem)
    const url = requirementsOf(file).find(isDirectUrlRequirement)
    if (url)
      return fail(`${next.path} requires a direct URL (${url.slice(0, 80)}), which uv would build`)
    const dir = repoDirname(next.path)
    for (const source of sourcesOf(file)) {
      if (/(?:^|[{,\s])(?:git|url)\s*=/.test(source.raw)) {
        return fail(
          `${next.path} takes ${source.name} from a git or URL source, which uv would build`,
        )
      }
      for (const target of stringField(source.raw, 'path')) {
        const joined = posix.normalize(posix.join(dir, target))
        if (posix.isAbsolute(target) || joined === '..' || joined.startsWith('../')) {
          return fail(`${next.path} takes ${source.name} from a path outside the repo`)
        }
        if (joined.endsWith('.whl')) continue
        if (/\.(?:tar\.gz|tgz|zip|tar\.bz2|tar\.xz)$/.test(joined)) {
          return fail(
            `${next.path} takes ${source.name} from a source archive, which uv would build`,
          )
        }
        queue.push({
          path: repoJoin(joined, 'pyproject.toml'),
          virtualAllowed: false,
          members: false,
        })
      }
    }
    if (next.members) {
      const workspace = entries.filter((e) => e.table.join('.') === 'tool.uv.workspace')
      const globs = (key: string) =>
        workspace
          .filter((e) => e.key.join('.') === key)
          .flatMap((e) => arrayStrings(text.slice(e.start, e.end)))
      const excluded = new Set<string>()
      for (const pattern of globs('exclude')) {
        const dirs = expandMembers(fs, dir, pattern)
        if (dirs === null)
          return fail(`${next.path} has a workspace exclude Hinomi does not expand`)
        for (const member of dirs) excluded.add(member)
      }
      for (const pattern of globs('members')) {
        const dirs = expandMembers(fs, dir, pattern)
        if (dirs === null)
          return fail(`${next.path} has a workspace member glob Hinomi does not expand`)
        for (const member of dirs) {
          if (excluded.has(member) || !(await fs.exists(repoJoin(member, 'pyproject.toml'))))
            continue
          queue.push({
            path: repoJoin(member, 'pyproject.toml'),
            virtualAllowed: false,
            members: false,
          })
        }
      }
    }
    files.push(file)
  }
  return { ok: true, files }
}
