import type { LockfileDependency } from '@hinomi/shared'
import { asDict, dedupeDependencies, isRegistryVersion, type Dict } from './graph.js'

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/** `node_modules/a/node_modules/@s/b` -> `@s/b`. */
function nameFromPath(path: string): string {
  const idx = path.lastIndexOf('node_modules/')
  return path.slice(idx + 'node_modules/'.length)
}

/** Number of `node_modules/` segments; 1 means installed at the top of a project or workspace. */
const nesting = (path: string) => path.split('node_modules/').length - 1

/**
 * package-lock.json / npm-shrinkwrap.json. Lockfile versions 2 and 3 use the
 * flat `packages` map where npm itself marks dev only entries with `dev` or
 * `devOptional`. Version 1 files (only the nested `dependencies` tree) are
 * read too, using the same `dev` flag.
 */
export function parsePackageLock(text: string): LockfileDependency[] {
  const doc = asDict(JSON.parse(text))
  const packages = asDict(doc.packages)
  if (Object.keys(packages).length > 0) return parsePackagesMap(packages)
  return parseLegacyTree(asDict(doc.dependencies))
}

function parsePackagesMap(packages: Dict): LockfileDependency[] {
  // Root ("") and workspace folders (paths without node_modules) are manifests.
  const directNames = new Set<string>()
  for (const [path, raw] of Object.entries(packages)) {
    if (path.includes('node_modules/')) continue
    const entry = asDict(raw)
    for (const field of MANIFEST_FIELDS) {
      for (const name of Object.keys(asDict(entry[field]))) directNames.add(name)
    }
  }

  const out: LockfileDependency[] = []
  for (const [path, raw] of Object.entries(packages)) {
    if (!path.includes('node_modules/')) continue
    const entry = asDict(raw)
    if (entry.link === true) continue
    const version = entry.version
    if (typeof version !== 'string' || !isRegistryVersion(version)) continue
    // Aliased installs (`"foo": "npm:bar@1"`) record the real name in `name`.
    const name = typeof entry.name === 'string' ? entry.name : nameFromPath(path)
    const installedAs = nameFromPath(path)
    out.push({
      name,
      version,
      ecosystem: 'npm',
      scope: entry.dev === true || entry.devOptional === true ? 'dev' : 'runtime',
      direct: nesting(path) === 1 && directNames.has(installedAs),
    })
  }
  return dedupeDependencies(out)
}

function parseLegacyTree(tree: Dict): LockfileDependency[] {
  const out: LockfileDependency[] = []
  const walk = (node: Dict) => {
    for (const [name, raw] of Object.entries(node)) {
      const entry = asDict(raw)
      const version = entry.version
      if (typeof version === 'string' && isRegistryVersion(version)) {
        out.push({
          name,
          version,
          ecosystem: 'npm',
          scope: entry.dev === true ? 'dev' : 'runtime',
          // v1 keeps no copy of the manifest, so direct is not knowable here.
          direct: false,
        })
      }
      walk(asDict(entry.dependencies))
    }
  }
  walk(tree)
  return dedupeDependencies(out)
}
