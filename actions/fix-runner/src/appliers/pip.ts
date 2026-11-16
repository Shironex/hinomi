import { posix } from 'node:path'
import type { FixDispatchStep } from '@hinomi/shared'
import { PYPI_API } from '../registry.js'
import { repoDirname, type RepoFs } from '../repo-fs.js'
import { compareVersions } from '../semver.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'
import { normalizePypiName } from './uv.js'

// requirements.txt with exact pins. The file is its own lockfile, so a step is a
// lockfile_update the runner makes as a text edit: the `==<from>` pin of the package becomes
// `==<to>`, extras, markers, comments and layout untouched. No tool runs at all, neither while
// applying nor as the install, so no package code runs. A pin with `--hash` options is left to
// a person: its hashes would have to change with it (regenerate the file with its tool).

/** One `name==version` pin: where its version sits in the text and whether it carries hashes. */
export interface RequirementPin {
  /** Normalized. */
  name: string
  version: string
  /** Offsets of the version in the file text, end exclusive. */
  start: number
  end: number
  hashed: boolean
}

// name, optional extras, `==` (not `===`), the version up to whitespace, `;`, `#` or `\`.
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==(?!=)\s*([^\s;#\\]+)/

/** The index PyPI publish times hold for, as `--index-url` may name it. */
const PYPI_SIMPLE = new Set(['https://pypi.org/simple', 'https://pypi.org/simple/'])

/** Most requirement files followed through `-r` and `-c` before a file is given up on. */
const MAX_INCLUDED_FILES = 20

/** One logical line: continuation lines joined, with the offset of its first character. */
interface LogicalLine {
  text: string
  start: number
}

/**
 * The logical lines of a requirements file as pip reads them: a trailing backslash joins the
 * next line, except on a comment line (pip keeps those apart, so a comment ending in `\` does
 * not swallow the requirement after it).
 */
function logicalLines(text: string): LogicalLine[] {
  const out: LogicalLine[] = []
  const lines = text.split('\n')
  let offset = 0
  let current: LogicalLine | null = null
  for (const line of lines) {
    const start = offset
    offset += line.length + 1
    const comment = /^\s*#/.test(line)
    if (current) current.text += `\n${line}`
    else current = { text: line, start }
    if (comment || !line.trimEnd().endsWith('\\')) {
      out.push(current)
      current = null
    }
  }
  if (current) out.push(current)
  return out
}

/** A logical line without its comment, continuations as spaces. */
function withoutComment(line: string): string {
  return line
    .replace(/\\\n/g, ' ')
    .replace(/(?:^|\s)#.*$/gm, '')
    .trim()
}

/** Every exact pin of a requirements.txt, continuation lines joined. */
export function requirementPins(text: string): RequirementPin[] {
  const pins: RequirementPin[] = []
  for (const { text: logical, start } of logicalLines(text)) {
    const lead = logical.length - logical.trimStart().length
    const match = PIN.exec(logical.slice(lead))
    if (!match?.[1] || !match[2]) continue
    const versionAt = start + lead + match[0].length - match[2].length
    pins.push({
      name: normalizePypiName(match[1]),
      version: match[2],
      start: versionAt,
      end: versionAt + match[2].length,
      hashed: /(?:^|\s)--hash[=\s]/.test(withoutComment(logical)),
    })
  }
  return pins
}

/** An option line split into its name and value: `-i URL`, `-iURL`, `--index-url=URL`. */
function optionOf(line: string): { name: string; value: string } | null {
  const long = /^(--[a-z-]+)(?:[=\s]\s*(.*))?$/.exec(line)
  if (long?.[1]) return { name: long[1], value: (long[2] ?? '').trim() }
  const short = /^(-[a-zA-Z])\s*(.*)$/.exec(line)
  if (short?.[1]) return { name: short[1], value: (short[2] ?? '').trim() }
  return null
}

const INCLUDE_OPTIONS = new Set(['-r', '--requirement', '-c', '--constraint'])
const INDEX_URL_OPTIONS = new Set(['-i', '--index-url'])
const OTHER_INDEX_OPTIONS = new Set(['--extra-index-url', '-f', '--find-links', '--no-index'])

/**
 * Whether the requirements file, and every file it pulls in with `-r` or `-c`, leaves PyPI as
 * the only index: an `--index-url` other than PyPI, `--extra-index-url`, `--find-links` or
 * `--no-index` anywhere, or an included file Hinomi cannot read inside the repo, means the
 * package may come from somewhere PyPI's publish times say nothing about.
 */
export async function onlyPypi(fs: RepoFs, file: string): Promise<boolean> {
  const queue = [file]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const path = queue.shift() ?? ''
    if (seen.has(path)) continue
    seen.add(path)
    if (seen.size > MAX_INCLUDED_FILES) return false
    const text = await fs.read(path).catch(() => null)
    if (text === null) return false
    for (const { text: logical } of logicalLines(text)) {
      const line = withoutComment(logical)
      if (!line.startsWith('-')) continue
      const option = optionOf(line)
      if (!option) return false
      if (OTHER_INDEX_OPTIONS.has(option.name)) return false
      if (INDEX_URL_OPTIONS.has(option.name) && !PYPI_SIMPLE.has(option.value)) return false
      if (INCLUDE_OPTIONS.has(option.name)) {
        const target = option.value
        if (
          !target ||
          posix.isAbsolute(target) ||
          target.includes('\\') ||
          /^[a-z][a-z0-9+.-]*:/i.test(target)
        )
          return false
        const joined = posix.normalize(posix.join(repoDirname(path), target))
        if (joined === '..' || joined.startsWith('../')) return false
        queue.push(joined)
      }
    }
  }
  return true
}

async function pinsOf(
  ctx: ProjectContext,
  name: string,
): Promise<{ text: string; pins: RequirementPin[] } | null> {
  const text = await ctx.fs.read(ctx.lockfile)
  if (text === null) return null
  const wanted = normalizePypiName(name)
  return { text, pins: requirementPins(text).filter((pin) => pin.name === wanted) }
}

/** Rewrites the pins of one step; the step names the versions it moves in `from`. */
export async function editPins(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'lockfile_update' || apply.tool !== 'pip') {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.type} is not a pin edit` }
  }
  const found = await pinsOf(ctx, apply.packageName)
  if (!found)
    return { status: 'failed', reason: 'edit_failed', detail: `${ctx.lockfile} is missing` }
  const moving = found.pins.filter(
    (pin) => apply.from.includes(pin.version) || compareVersions(pin.version, apply.to) < 0,
  )
  if (moving.length === 0) {
    return {
      status: 'failed',
      reason: 'edit_failed',
      detail: `${ctx.lockfile} pins no version of ${apply.packageName} below ${apply.to}`,
    }
  }
  if (moving.some((pin) => pin.hashed)) {
    return {
      status: 'skipped',
      reason: 'manual_specifier',
      detail: `${ctx.lockfile} pins ${apply.packageName} with --hash: regenerate it with its tool`,
    }
  }
  let text = found.text
  for (const pin of [...moving].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, pin.start) + apply.to + text.slice(pin.end)
  }
  await ctx.fs.write(ctx.lockfile, text)
  return { status: 'edited', files: [ctx.lockfile] }
}

export const pipApplier: Applier = {
  packageManager: 'pip',
  lockfiles: ['requirements.txt'],
  // Display only: no pip command runs for a fix.
  versionCommand: { file: 'python3', args: ['--version'] },

  async resolvedVersions(ctx, name) {
    const found = await pinsOf(ctx, name)
    return [...new Set((found?.pins ?? []).map((pin) => pin.version))]
  },

  // requirements.txt has no release age setting; Hinomi's floor applies.
  releaseAgeGate: () => Promise.resolve(null),

  async publishedAt(ctx, name, version) {
    if (!(await onlyPypi(ctx.fs, ctx.lockfile))) return null
    return ctx.publishTimes.publishedAt(normalizePypiName(name), version, PYPI_API)
  },

  applyStep: editPins,

  // The edit is the whole lockfile update; no tool runs.
  lockfileInstall: () => [],

  // Installing would build source distributions (package code); the fix PR's CI installs.
  fullInstall: () => null,

  checks: () => Promise.resolve([]),
}
