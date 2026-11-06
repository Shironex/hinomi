import type { LockfileScope, LockfileDependency, OsvEcosystem } from '@hinomi/shared'

/** One resolved package in a lockfile graph, keyed by the lockfile's own id. */
export interface GraphNode {
  name: string
  version: string
  /** Keys of the nodes this one depends on. */
  deps: string[]
}

export interface GraphInput {
  ecosystem: OsvEcosystem
  nodes: Map<string, GraphNode>
  /** Node keys depended on by production manifests (dependencies, optional). */
  prodRoots: Iterable<string>
  /** Node keys depended on only for development. */
  devRoots: Iterable<string>
  /** Node keys listed directly by any manifest. */
  directKeys: Iterable<string>
  /** When false every scope is `unknown` (no manifest to tell prod from dev). */
  scopeKnown: boolean
}

function reachable(nodes: Map<string, GraphNode>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const key = stack.pop()!
    if (seen.has(key)) continue
    const node = nodes.get(key)
    if (!node) continue
    seen.add(key)
    for (const dep of node.deps) if (!seen.has(dep)) stack.push(dep)
  }
  return seen
}

/**
 * Walks the graph: anything reachable from a production root is runtime, the
 * rest reachable from dev roots is dev. Nodes reachable from neither (orphans,
 * or graphs without roots) fall back to `unknown`.
 */
export function classifyGraph(input: GraphInput): LockfileDependency[] {
  const runtime = input.scopeKnown ? reachable(input.nodes, input.prodRoots) : new Set<string>()
  const dev = input.scopeKnown ? reachable(input.nodes, input.devRoots) : new Set<string>()
  const direct = new Set(input.directKeys)
  const out: LockfileDependency[] = []
  for (const [key, node] of input.nodes) {
    let scope: LockfileScope = 'unknown'
    if (runtime.has(key)) scope = 'runtime'
    else if (dev.has(key)) scope = 'dev'
    out.push({
      name: node.name,
      version: node.version,
      ecosystem: input.ecosystem,
      scope,
      direct: direct.has(key),
    })
  }
  return dedupeDependencies(out)
}

export type Dict = Record<string, unknown>

/** Narrows parsed JSON or YAML to a plain object, anything else becomes `{}`. */
export const asDict = (value: unknown): Dict =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {}

/** A YAML or JSON scalar as text (YAML may type `9.0` or `1.2` as numbers), else `''`. */
export const scalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''

const scopeRank: Record<LockfileScope, number> = { runtime: 2, dev: 1, unknown: 0 }

/**
 * Collapses duplicates of the same name and version (peer variants, several
 * lockfiles of one repo). Runtime beats dev beats unknown; direct wins.
 */
export function dedupeDependencies(deps: Iterable<LockfileDependency>): LockfileDependency[] {
  const byKey = new Map<string, LockfileDependency>()
  for (const dep of deps) {
    const key = `${dep.ecosystem}\u0000${dep.name}\u0000${dep.version}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...dep })
      continue
    }
    if (scopeRank[dep.scope] > scopeRank[prev.scope]) prev.scope = dep.scope
    prev.direct = prev.direct || dep.direct
  }
  return [...byKey.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

/** Splits `name@range` where the name may be scoped (`@scope/name@range`). */
export function splitAtVersion(spec: string): { name: string; rest: string } | null {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  if (at <= 0) return null
  return { name: spec.slice(0, at), rest: spec.slice(at + 1) }
}

/** True for registry style versions (`1.2.3`, `1.2.3-rc.1`), false for links, git, tarballs. */
export function isRegistryVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(version)
}

export interface PackageJsonDeps {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

/** Reads the dependency maps of a package.json, tolerating missing or odd fields. */
export function readPackageJson(text: string): PackageJsonDeps {
  const json = JSON.parse(text) as Record<string, unknown>
  return {
    dependencies: stringRecord(json.dependencies),
    devDependencies: stringRecord(json.devDependencies),
    optionalDependencies: stringRecord(json.optionalDependencies),
  }
}
