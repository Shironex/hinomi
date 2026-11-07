import type { LockfileDependency } from '@hinomi/shared'
import { addWorkspace, classifyGraph, type GraphNode } from './graph.js'

interface CargoPackage {
  name: string
  version: string
  source: string | null
  dependencies: string[]
}

const tomlString = (value: string) => value.trim().replace(/^"(.*)"$/, '$1')

/**
 * Cargo.lock. Only the `[[package]]` tables matter and they use a fixed,
 * simple TOML subset, so they are read line by line. Packages without a
 * `source` are the workspace's own crates: their dependencies are the direct
 * ones. Cargo.lock does not separate dev dependencies, so scope is `unknown`.
 */
export function parseCargoLock(text: string): LockfileDependency[] {
  const packages: CargoPackage[] = []
  let current: CargoPackage | null = null
  let inDeps = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDeps = false
      current =
        line === '[[package]]' ? { name: '', version: '', source: null, dependencies: [] } : null
      if (current) packages.push(current)
      continue
    }
    if (!current || line === '' || line.startsWith('#')) continue
    if (inDeps) {
      if (line.startsWith(']')) inDeps = false
      else current.dependencies.push(tomlString(line.replace(/,$/, '')))
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'name') current.name = tomlString(value)
    else if (key === 'version') current.version = tomlString(value)
    else if (key === 'source') current.source = tomlString(value)
    else if (key === 'dependencies') {
      // Either `dependencies = [` followed by lines, or a one line array.
      const inline = /^\[(.*)\]$/.exec(value)
      if (inline) {
        for (const item of inline[1]!.split(',')) {
          if (item.trim()) current.dependencies.push(tomlString(item))
        }
      } else inDeps = true
    }
  }

  // Dependency entries are `name`, `name version` or `name version (source)`.
  const keyOf = (p: CargoPackage) => `${p.name} ${p.version}`
  const byName = new Map<string, CargoPackage[]>()
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  const resolve = (dep: string): string | null => {
    const [name, version] = dep.split(' ')
    const candidates = byName.get(name ?? '') ?? []
    const hit = version ? candidates.find((c) => c.version === version) : candidates[0]
    return hit ? keyOf(hit) : null
  }

  const nodes = new Map<string, GraphNode>()
  const directKeys: string[] = []
  const workspaces = new Map<string, Set<string>>()
  for (const p of packages) {
    const deps = p.dependencies.flatMap((d) => resolve(d) ?? [])
    if (p.source === null) {
      directKeys.push(...deps)
      for (const dep of deps) addWorkspace(workspaces, dep, p.name)
    } else if (p.source.startsWith('registry+') || p.source.startsWith('sparse+')) {
      nodes.set(keyOf(p), { name: p.name, version: p.version, deps })
    }
  }

  return classifyGraph({
    ecosystem: 'crates.io',
    nodes,
    prodRoots: [],
    devRoots: [],
    directKeys,
    scopeKnown: false,
    workspaces,
  })
}
