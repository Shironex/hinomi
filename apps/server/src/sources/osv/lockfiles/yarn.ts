import type { LockfileDependency } from '@hinomi/shared'
import { parse } from 'yaml'
import {
  asDict,
  classifyGraph,
  isRegistryVersion,
  readPackageJson,
  scalarText,
  splitAtVersion,
  type GraphNode,
  type PackageJsonDeps,
} from './graph.js'

interface YarnEntry {
  /** Descriptors (`name@range`) that resolve to this entry. */
  descriptors: string[]
  name: string
  version: string
  /** Dependency descriptors, already in the lockfile's descriptor form. */
  deps: string[]
  /** Berry workspace entries, which list the manifests' own dependencies. */
  workspace: boolean
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1')

/**
 * yarn.lock, both the classic v1 format and Berry (v2+, YAML). The lockfile
 * does not tell dev from prod, so scope is `unknown` unless the package.json
 * text is passed in. Berry marks direct dependencies through its workspace
 * entries; v1 only knows them with package.json.
 */
export function parseYarnLock(text: string, packageJson?: string): LockfileDependency[] {
  const berry = /^__metadata:/m.test(text)
  const entries = berry ? parseBerry(text) : parseClassic(text)
  const manifest = packageJson ? readPackageJson(packageJson) : null
  return buildGraph(entries, manifest, berry)
}

function buildGraph(
  entries: YarnEntry[],
  manifest: PackageJsonDeps | null,
  berry: boolean,
): LockfileDependency[] {
  const byDescriptor = new Map<string, string>()
  const nodes = new Map<string, GraphNode>()
  entries.forEach((entry, i) => {
    const key = String(i)
    for (const d of entry.descriptors) byDescriptor.set(d, key)
  })
  entries.forEach((entry, i) => {
    if (entry.workspace || !isRegistryVersion(entry.version)) return
    const deps = entry.deps.flatMap((d) => byDescriptor.get(d) ?? [])
    nodes.set(String(i), { name: entry.name, version: entry.version, deps })
  })

  // Berry stores `npm:` in descriptors; package.json ranges usually omit it.
  const resolve = (name: string, range: string): string | undefined =>
    byDescriptor.get(`${name}@${range}`) ??
    (berry && !range.includes(':') ? byDescriptor.get(`${name}@npm:${range}`) : undefined)

  const directKeys = new Set<string>()
  for (const entry of entries) {
    if (!entry.workspace) continue
    for (const d of entry.deps) {
      const key = byDescriptor.get(d)
      if (key) directKeys.add(key)
    }
  }

  const prodRoots: string[] = []
  const devRoots: string[] = []
  if (manifest) {
    const add = (deps: Record<string, string>, into: string[]) => {
      for (const [name, range] of Object.entries(deps)) {
        const key = resolve(name, range)
        if (key) {
          into.push(key)
          directKeys.add(key)
        }
      }
    }
    add(manifest.dependencies, prodRoots)
    add(manifest.optionalDependencies, prodRoots)
    add(manifest.devDependencies, devRoots)
  }

  return classifyGraph({
    ecosystem: 'npm',
    nodes,
    prodRoots,
    devRoots,
    directKeys,
    scopeKnown: manifest !== null,
  })
}

/** `"a@^1", a@^1.2` -> [`a@^1`, `a@^1.2`]. */
const splitDescriptors = (header: string) =>
  header
    .split(',')
    .map(unquote)
    .filter((d) => d.length > 0)

/** Name of a descriptor, taking aliases (`alias@npm:real@^1`) to the real package. */
function descriptorName(descriptor: string): string | null {
  const split = splitAtVersion(descriptor)
  if (!split) return null
  if (split.rest.startsWith('npm:')) {
    const inner = splitAtVersion(split.rest.slice(4))
    if (inner) return inner.name
  }
  return split.name
}

/** Classic yarn v1: an indentation based format, parsed line by line. */
function parseClassic(text: string): YarnEntry[] {
  const entries: YarnEntry[] = []
  let current: YarnEntry | null = null
  let inDeps = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (indent === 0) {
      const descriptors = splitDescriptors(body.replace(/:$/, ''))
      const name = descriptors[0] ? descriptorName(descriptors[0]) : null
      current = name ? { descriptors, name, version: '', deps: [], workspace: false } : null
      if (current) entries.push(current)
      inDeps = false
      continue
    }
    if (!current) continue
    if (indent === 2) {
      inDeps = body === 'dependencies:' || body === 'optionalDependencies:'
      const version = /^version\s+"?([^"\s]+)"?$/.exec(body)
      if (version?.[1]) current.version = version[1]
      continue
    }
    if (inDeps && indent >= 4) {
      const m = /^("[^"]+"|\S+)\s+"?([^"]*)"?$/.exec(body)
      if (m?.[1] && m[2] !== undefined) current.deps.push(`${unquote(m[1])}@${m[2]}`)
    }
  }
  return entries
}

/** Berry: YAML with comma joined descriptor keys and `resolution: name@npm:1.2.3`. */
function parseBerry(text: string): YarnEntry[] {
  const doc = asDict(parse(text, { maxAliasCount: -1 }))
  const entries: YarnEntry[] = []
  for (const [header, raw] of Object.entries(doc)) {
    if (header === '__metadata') continue
    const entry = asDict(raw)
    const resolution = typeof entry.resolution === 'string' ? entry.resolution : ''
    const split = splitAtVersion(resolution)
    if (!split) continue
    const version = scalarText(entry.version)
    const deps: string[] = []
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(asDict(entry[field]))) {
        if (typeof range === 'string') deps.push(`${name}@${range}`)
      }
    }
    const isNpm = split.rest.startsWith('npm:') || split.rest.startsWith('patch:')
    entries.push({
      descriptors: splitDescriptors(header),
      name: split.name,
      // Non registry resolutions (git, file) get an empty version and are skipped.
      version: isNpm ? version : '',
      deps,
      workspace: split.rest.startsWith('workspace:'),
    })
  }
  return entries
}
