import type { LockfileDependency, LockfileScope } from '@hinomi/shared'
import { dedupeDependencies } from './graph.js'

/** What a requirements file listed but Hinomi could not check, by reason. */
export interface RequirementsNotChecked {
  /** Names with no exact pin (`>=1.0`, `~=1.4`, `==1.*`, a bare name). */
  unpinned: number
  /** `-r` and `-c` includes: not followed, so whatever they list is not checked. */
  includes: number
  /** `-e` editable installs, URLs, VCS and local path requirements: no registry version. */
  direct: number
}

export interface ParsedRequirements {
  dependencies: LockfileDependency[]
  notChecked: RequirementsNotChecked
}

export interface RequirementsOptions {
  /** File name (a path is fine): `dev` or `test` in it makes the pins dev scope. */
  filename?: string
}

/** PEP 503: runs of `-`, `_` and `.` are one `-`, lower case. */
export const normalizePypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/
const EXACT = /^===?\s*([^\s*,;]+)$/
const INCLUDE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint'])
const EDITABLE_FLAGS = new Set(['-e', '--editable'])

/** Joins `\` continuations and strips comments (`#` at line start or after whitespace). */
function logicalLines(text: string): string[] {
  const out: string[] = []
  let pending = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    if (line.trimEnd().endsWith('\\')) {
      pending += `${line.trimEnd().slice(0, -1)} `
      continue
    }
    out.push((pending + line).trim())
    pending = ''
  }
  if (pending.trim()) out.push(pending.trim())
  return out.filter((l) => l !== '')
}

/** The version a clause list pins exactly (`==` or `===`, no wildcard), else null. */
function exactVersion(spec: string): string | null {
  for (const clause of spec.replace(/^\(|\)$/g, '').split(',')) {
    const m = EXACT.exec(clause.trim())
    if (m) return m[1]!
  }
  return null
}

/**
 * requirements.txt. Only exact pins (`name==1.2.3`, `===`) are versions; extras, environment
 * markers (after `;`), `--hash` options, comments and line continuations are tolerated. Anything
 * else is counted in `notChecked` so the caller can say what was left out, never guessed.
 * All pins are direct and carry no path. Scope is dev when the file name has `dev` or `test`.
 */
export function parseRequirementsTxtDetailed(
  text: string,
  options: RequirementsOptions = {},
): ParsedRequirements {
  const base = (options.filename ?? '').slice((options.filename ?? '').lastIndexOf('/') + 1)
  const scope: LockfileScope = /dev|test/i.test(base) ? 'dev' : 'runtime'
  const notChecked: RequirementsNotChecked = { unpinned: 0, includes: 0, direct: 0 }
  const deps: LockfileDependency[] = []

  for (const line of logicalLines(text)) {
    if (line.startsWith('-')) {
      const flag = line.split(/[\s=]/, 1)[0]!
      if (INCLUDE_FLAGS.has(flag) || /^-[rc]\S/.test(line)) notChecked.includes++
      else if (EDITABLE_FLAGS.has(flag) || /^-e\S/.test(line)) notChecked.direct++
      continue // index urls, --hash-only lines and other global options list no package
    }
    // Per requirement options (`--hash=...`) start after whitespace; markers after `;`.
    const requirement = line.split(/\s+--/, 1)[0]!
    const spec = requirement.split(';', 1)[0]!.trim()
    if (/:\/\/|^[./~]|^file:|@\s*\S/.test(spec)) {
      notChecked.direct++
      continue
    }
    const m = NAME.exec(spec)
    if (!m) continue
    const version = exactVersion(m[2]!)
    if (version === null) {
      notChecked.unpinned++
      continue
    }
    deps.push({
      name: normalizePypiName(m[1]!),
      version,
      ecosystem: 'PyPI',
      scope,
      direct: true,
    })
  }
  return { dependencies: dedupeDependencies(deps), notChecked }
}

/** The registry entry: the pins only. Use `parseRequirementsTxtDetailed` for the counts. */
export function parseRequirementsTxt(
  text: string,
  options: RequirementsOptions = {},
): LockfileDependency[] {
  return parseRequirementsTxtDetailed(text, options).dependencies
}
