import type { LockfileDependency } from '@hinomi/shared'
import { classifyGraph, type GraphNode } from './graph.js'

/** `name (1.2.3)` or `name (>= 1.0, < 2)` or a bare `name`, with an optional `!` suffix. */
const ENTRY = /^([^\s(!]+)(?:\s+\(([^)]*)\))?(!)?$/

/**
 * A platform gem is listed as `1.15.4-x86_64-linux`. Gem versions never contain a hyphen of
 * their own, so everything from the first one on is the platform and OSV matches the rest.
 */
const stripPlatform = (version: string) => {
  const dash = version.indexOf('-')
  return dash === -1 ? version : version.slice(0, dash)
}

/**
 * Gemfile.lock. The format is indentation based: a section header at column 0, then in a `GEM`
 * section `specs:` followed by gems at 4 spaces (`name (version)`) and their dependencies at
 * 6 spaces. `GIT` and `PATH` sections hold gems that are not on a registry, so they are skipped,
 * and so is every other section. `DEPENDENCIES` lists the direct gems. Bundler groups live in
 * the Gemfile, not the lock, so scope is `unknown`. Platform variants of one gem collapse into
 * a single entry.
 */
export function parseGemfileLock(text: string): LockfileDependency[] {
  const versions = new Map<string, string>()
  const depNames = new Map<string, Set<string>>()
  const directNames: string[] = []

  let section = ''
  let inSpecs = false
  let current: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (indent === 0) {
      section = body
      inSpecs = false
      current = null
      continue
    }
    if (section === 'GEM') {
      if (indent === 2) {
        inSpecs = body === 'specs:'
        current = null
      } else if (inSpecs && indent === 4) {
        const match = ENTRY.exec(body)
        current = null
        if (!match?.[2]) continue
        const name = match[1]!
        current = name
        if (!versions.has(name)) versions.set(name, stripPlatform(match[2]))
        if (!depNames.has(name)) depNames.set(name, new Set())
      } else if (inSpecs && indent === 6 && current) {
        const match = ENTRY.exec(body)
        if (match) depNames.get(current)?.add(match[1]!)
      }
    } else if (section === 'DEPENDENCIES' && indent === 2) {
      const match = ENTRY.exec(body)
      // `!` marks a gem from a git, path or other non registry source, never in GEM specs.
      if (match) directNames.push(match[1]!)
    }
  }

  const nodes = new Map<string, GraphNode>()
  for (const [name, version] of versions) {
    const deps = [...(depNames.get(name) ?? [])].filter((dep) => versions.has(dep))
    nodes.set(name, { name, version, deps })
  }
  return classifyGraph({
    ecosystem: 'RubyGems',
    nodes,
    prodRoots: [],
    devRoots: [],
    directKeys: directNames.filter((name) => nodes.has(name)),
    scopeKnown: false,
  })
}
