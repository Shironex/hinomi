import type { LockfileDependency } from '@hinomi/shared'
import {
  asDict,
  classifyGraph,
  isRegistryVersion,
  splitAtVersion,
  type Dict,
  type GraphNode,
} from './graph.js'

/**
 * Turns JSONC into JSON: drops `//` and block comments and trailing commas,
 * leaving string contents untouched.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] !== '}' && text[j] !== ']') out += ch
      i++
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** `a/@s/b/c` -> [`a`, `@s/b`, `c`]: a bun package key is a path of package names. */
function keySegments(key: string): string[] {
  const parts = key.split('/')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.startsWith('@') && i + 1 < parts.length) out.push(`${part}/${parts[++i]}`)
    else out.push(part)
  }
  return out
}

/**
 * Finds the key a dependency resolves to from a given package key, the same
 * way node_modules lookup climbs: `a/b/dep`, then `a/dep`, then `dep`.
 */
function resolveKey(packages: Dict, from: string[], dep: string): string | null {
  for (let len = from.length; len >= 0; len--) {
    const key = [...from.slice(0, len), dep].join('/')
    if (key in packages) return key
  }
  return null
}

const PROD_FIELDS = ['dependencies', 'optionalDependencies'] as const

/**
 * bun.lock, the text (JSONC) lockfile of Bun 1.2+. `workspaces` holds every
 * manifest's dependency maps; `packages` entries are
 * `[ "name@version", registry, { dependencies, ... }, integrity ]`.
 */
export function parseBunLock(text: string): LockfileDependency[] {
  const doc = asDict(JSON.parse(stripJsonc(text)))
  const packages = asDict(doc.packages)
  const workspaces = asDict(doc.workspaces)

  const nodes = new Map<string, GraphNode>()
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') continue
    const split = splitAtVersion(raw[0])
    if (!split || !isRegistryVersion(split.rest)) continue
    const info = asDict(raw[2])
    const segments = keySegments(key)
    const deps: string[] = []
    for (const field of PROD_FIELDS) {
      for (const depName of Object.keys(asDict(info[field]))) {
        const target = resolveKey(packages, segments, depName)
        if (target) deps.push(target)
      }
    }
    nodes.set(key, { name: split.name, version: split.rest, deps })
  }

  const prodRoots: string[] = []
  const devRoots: string[] = []
  for (const raw of Object.values(workspaces)) {
    const ws = asDict(raw)
    // Conflicting versions inside one workspace are keyed under its package name.
    const from = typeof ws.name === 'string' ? [ws.name] : []
    const add = (field: string, into: string[]) => {
      for (const depName of Object.keys(asDict(ws[field]))) {
        const target = resolveKey(packages, from, depName)
        if (target) into.push(target)
      }
    }
    for (const field of PROD_FIELDS) add(field, prodRoots)
    add('devDependencies', devRoots)
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
