import type { LockfileDependency } from '@hinomi/shared'
import { parse } from 'yaml'
import {
  asDict,
  classifyGraph,
  isRegistryVersion,
  scalarText,
  splitAtVersion,
  type GraphNode,
} from './graph.js'

const PROD_FIELDS = ['dependencies', 'optionalDependencies'] as const
const DEV_FIELDS = ['devDependencies'] as const

/**
 * Parses a package id such as `/foo@1.0.0(peer@2.0.0)` (v6) or
 * `@scope/foo@1.0.0(peer@2.0.0)` (v9) into name and bare version.
 */
function parsePackageId(id: string): { name: string; version: string } | null {
  const trimmed = id.startsWith('/') ? id.slice(1) : id
  const paren = trimmed.indexOf('(')
  const base = paren === -1 ? trimmed : trimmed.slice(0, paren)
  const split = splitAtVersion(base)
  if (!split) return null
  return { name: split.name, version: split.rest }
}

/**
 * Turns a dependency reference (`name` plus the value in a dependency map) into
 * the package id used as a key in `packages` (v6) or `snapshots` (v9).
 * Returns null for workspace links and local files.
 */
function refToKey(name: string, ref: string, v6: boolean): string | null {
  if (/^(link|file|workspace):/.test(ref)) return null
  // A ref that already names a package is an alias (`npm:` style), e.g. `string-width@4.2.3`.
  const looksAliased = !/^\d/.test(ref) && splitAtVersion(ref.startsWith('/') ? ref.slice(1) : ref)
  const id = looksAliased ? ref : `${name}@${ref}`
  if (!v6) return id
  return id.startsWith('/') ? id : `/${id}`
}

/** Importer dependency values are `{ specifier, version }` objects; older v6 single-project files use the same. */
function importerRef(value: unknown): string | null {
  if (typeof value === 'string') return value
  const version = asDict(value).version
  return typeof version === 'string' ? version : null
}

/**
 * pnpm-lock.yaml, lockfile versions 6.x and 9.x. Importers give the direct
 * dependencies and prod vs dev; the package graph is walked so a transitive
 * package counts as runtime when any importer's production dependency reaches it.
 */
export function parsePnpmLock(text: string): LockfileDependency[] {
  const doc = asDict(parse(text, { maxAliasCount: -1 }))
  const version = scalarText(doc.lockfileVersion)
  const v6 = !version.startsWith('9')

  // v9 keeps the graph in `snapshots`; v6 keeps it in `packages`.
  const graphSource = asDict(v6 ? doc.packages : (doc.snapshots ?? doc.packages))
  const nodes = new Map<string, GraphNode>()
  for (const [id, raw] of Object.entries(graphSource)) {
    const parsed = parsePackageId(id)
    if (!parsed || !isRegistryVersion(parsed.version)) continue
    const entry = asDict(raw)
    const deps: string[] = []
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [depName, depRef] of Object.entries(asDict(entry[field]))) {
        if (typeof depRef !== 'string') continue
        const key = refToKey(depName, depRef, v6)
        if (key) deps.push(key)
      }
    }
    nodes.set(id, { name: parsed.name, version: parsed.version, deps })
  }

  // Single-project v6 lockfiles put the importer fields at the top level.
  const importers = doc.importers ? asDict(doc.importers) : { '.': doc }
  const prodRoots: string[] = []
  const devRoots: string[] = []
  for (const importer of Object.values(importers)) {
    const fields = asDict(importer)
    const collect = (names: readonly string[], into: string[]) => {
      for (const field of names) {
        for (const [depName, value] of Object.entries(asDict(fields[field]))) {
          const ref = importerRef(value)
          const key = ref ? refToKey(depName, ref, v6) : null
          if (key) into.push(key)
        }
      }
    }
    collect(PROD_FIELDS, prodRoots)
    collect(DEV_FIELDS, devRoots)
  }

  return classifyGraph({
    ecosystem: 'npm',
    nodes,
    prodRoots,
    devRoots,
    directKeys: [...prodRoots, ...devRoots],
    scopeKnown: true,
  })
}
