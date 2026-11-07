import type { LockfileDependency } from '@hinomi/shared'
import { addWorkspace, classifyGraph, type GraphNode } from './graph.js'
import { normalizePypiName } from './requirements.js'
import { asArray, asString, asTable, isTable, parseToml, type TomlTable } from './toml.js'

/** Resolved candidates of a dependency name, by normalised name. */
type ByName = Map<string, string[]>

function indexByName(nodes: Map<string, GraphNode>): ByName {
  const byName: ByName = new Map()
  for (const [key, node] of nodes) byName.set(node.name, [...(byName.get(node.name) ?? []), key])
  return byName
}

const keyOf = (name: string, version: string) => `${name}@${version}`

/**
 * uv.lock. A package whose source is `editable` or `virtual` is a project of the workspace: its
 * `dependencies` and `optional-dependencies` are the production roots and its `dev-dependencies`
 * groups the dev roots. Packages from git, a path, a URL or a directory have no registry version
 * OSV could match, so they stay in the graph (their dependencies are still walked) but are not
 * reported.
 */
export function parseUvLock(text: string): LockfileDependency[] {
  const packages = asArray(parseToml(text).package).filter(isTable)
  const nodes = new Map<string, GraphNode>()
  const checkable = new Set<string>()
  const projects: TomlTable[] = []
  const rawDeps = new Map<string, TomlTable[]>()

  for (const pkg of packages) {
    const name = normalizePypiName(asString(pkg.name))
    const version = asString(pkg.version)
    if (!name) continue
    const source = asTable(pkg.source)
    if (Object.hasOwn(source, 'editable') || Object.hasOwn(source, 'virtual')) {
      projects.push(pkg)
      continue
    }
    if (!version) continue
    const key = keyOf(name, version)
    nodes.set(key, { name, version, deps: [] })
    if (Object.hasOwn(source, 'registry')) checkable.add(key)
    rawDeps.set(key, depEntries(pkg.dependencies))
  }

  const byName = indexByName(nodes)
  const resolve = (entries: TomlTable[]): string[] =>
    entries.flatMap((entry) => {
      const name = normalizePypiName(asString(entry.name))
      const version = asString(entry.version)
      const candidates = byName.get(name) ?? []
      return version ? candidates.filter((k) => nodes.get(k)?.version === version) : candidates
    })
  for (const [key, entries] of rawDeps) nodes.get(key)!.deps = resolve(entries)

  const prodRoots: string[] = []
  const devRoots: string[] = []
  const workspaces = new Map<string, Set<string>>()
  for (const project of projects) {
    const workspace = normalizePypiName(asString(project.name))
    const prod = [
      ...resolve(depEntries(project.dependencies)),
      ...Object.values(asTable(project['optional-dependencies'])).flatMap((group) =>
        resolve(depEntries(group)),
      ),
    ]
    const dev = Object.values(asTable(project['dev-dependencies'])).flatMap((group) =>
      resolve(depEntries(group)),
    )
    prodRoots.push(...prod)
    devRoots.push(...dev)
    for (const key of [...prod, ...dev]) addWorkspace(workspaces, key, workspace)
  }

  return classifyGraph({
    ecosystem: 'PyPI',
    nodes,
    prodRoots,
    devRoots,
    directKeys: [...prodRoots, ...devRoots],
    scopeKnown: projects.length > 0,
    workspaces,
  }).filter((dep) => checkable.has(keyOf(dep.name, dep.version)))
}

const depEntries = (value: unknown): TomlTable[] => asArray(value).filter(isTable)

/** Poetry `[package.source]` types that are not a registry release of the locked version. */
const POETRY_UNCHECKABLE = new Set(['git', 'directory', 'file', 'url'])

/**
 * poetry.lock, both layouts. Poetry 1.x marks `category = "main" | "dev"`, 2.x lists
 * `groups = ["main", "dev"]`: a package in `main` is runtime, any other group is dev. The lock
 * does not name the project's direct dependencies (pyproject.toml does), so a package nothing
 * else depends on counts as direct. Packages from git, a directory, a file or a URL are not
 * reported: their locked version is not a registry release.
 */
export function parsePoetryLock(text: string): LockfileDependency[] {
  const packages = asArray(parseToml(text).package).filter(isTable)
  const nodes = new Map<string, GraphNode>()
  const checkable = new Set<string>()
  const runtime = new Set<string>()
  const knownScope = new Set<string>()
  const rawDeps = new Map<string, string[]>()

  for (const pkg of packages) {
    const name = normalizePypiName(asString(pkg.name))
    const version = asString(pkg.version)
    if (!name || !version) continue
    const key = keyOf(name, version)
    nodes.set(key, { name, version, deps: [] })
    if (!POETRY_UNCHECKABLE.has(asString(asTable(pkg.source).type))) checkable.add(key)
    const groups = asArray(pkg.groups).filter((g): g is string => typeof g === 'string')
    const category = asString(pkg.category)
    if (groups.length > 0 || category) {
      knownScope.add(key)
      if (groups.includes('main') || category === 'main') runtime.add(key)
    }
    rawDeps.set(key, Object.keys(asTable(pkg.dependencies)).map(normalizePypiName))
  }

  const byName = indexByName(nodes)
  const dependedOn = new Set<string>()
  for (const [key, names] of rawDeps) {
    const deps = names.flatMap((n) => byName.get(n) ?? []).filter((k) => k !== key)
    nodes.get(key)!.deps = deps
    for (const dep of deps) dependedOn.add(dep)
  }

  const roots = [...nodes.keys()].filter((key) => !dependedOn.has(key))
  const scopeKnown = knownScope.size > 0
  const out = classifyGraph({
    ecosystem: 'PyPI',
    nodes,
    prodRoots: roots.filter((key) => runtime.has(key)),
    devRoots: roots.filter((key) => !runtime.has(key)),
    directKeys: roots,
    scopeKnown,
  })
  return out
    .filter((dep) => checkable.has(keyOf(dep.name, dep.version)))
    .map((dep) => {
      const key = keyOf(dep.name, dep.version)
      // Poetry states each package's scope itself; trust that over reachability.
      return knownScope.has(key) ? { ...dep, scope: runtime.has(key) ? 'runtime' : 'dev' } : dep
    })
}
