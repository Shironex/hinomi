import type { LockfileDependency } from '@hinomi/shared'
import { asDict, classifyGraph, scalarText, type GraphNode } from './graph.js'

/** Platform packages and Composer's own, which are not Packagist packages. */
const PLATFORM = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|ext-.+|lib-.+|composer(?:-.+)?)$/i

/** Dev branch versions (`dev-main`, `1.x-dev`) name a branch, not a release OSV can match. */
const isDevBranch = (version: string) => /^dev-/i.test(version) || /-dev$/i.test(version)

/** Packagist versions in OSV carry no leading `v`. */
const normalizeVersion = (version: string) => version.trim().replace(/^v(?=\d)/i, '')

interface Entry {
  key: string
  dev: boolean
  requires: string[]
}

/**
 * composer.lock. JSON with `packages` (runtime) and `packages-dev` (dev), each package listing
 * its `require`. The lock has no root manifest, so the packages nobody else requires stand in
 * for the direct ones (composer.json is not read). Platform packages and dev branch versions
 * are skipped. Scope comes from the section a package sits in.
 */
export function parseComposerLock(text: string): LockfileDependency[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const root = asDict(json)
  const nodes = new Map<string, GraphNode>()
  const entries: Entry[] = []
  const byName = new Map<string, string>()
  for (const [section, dev] of [
    ['packages', false],
    ['packages-dev', true],
  ] as const) {
    const list = root[section]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const pkg = asDict(item)
      const name = typeof pkg.name === 'string' ? pkg.name.toLowerCase() : ''
      const rawVersion = scalarText(pkg.version)
      if (!name || !rawVersion || PLATFORM.test(name) || isDevBranch(rawVersion)) continue
      const version = normalizeVersion(rawVersion)
      const key = `${name}@${version}`
      if (nodes.has(key)) continue
      nodes.set(key, { name, version, deps: [] })
      byName.set(name, key)
      entries.push({ key, dev, requires: Object.keys(asDict(pkg.require)) })
    }
  }

  const required = new Set<string>()
  for (const entry of entries) {
    const deps = nodes.get(entry.key)!.deps
    for (const req of entry.requires) {
      const target = byName.get(req.toLowerCase())
      if (target && target !== entry.key) {
        deps.push(target)
        required.add(target)
      }
    }
  }

  const devByKey = new Map(entries.map((e) => [e.key, e.dev]))
  const roots = entries.filter((e) => !required.has(e.key))
  const out = classifyGraph({
    ecosystem: 'Packagist',
    nodes,
    prodRoots: roots.filter((e) => !e.dev).map((e) => e.key),
    devRoots: roots.filter((e) => e.dev).map((e) => e.key),
    directKeys: roots.map((e) => e.key),
    scopeKnown: true,
  })
  // The section decides the scope, whatever the walk reached first.
  return out.map((dep) => ({
    ...dep,
    scope: devByKey.get(`${dep.name}@${dep.version}`) ? 'dev' : 'runtime',
  }))
}
