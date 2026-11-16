import type { FixDispatchStep } from '@hinomi/shared'
import { PYPI_API } from '../registry.js'
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

/** Options that send pip to another index, whose publish times PyPI cannot vouch for. */
const INDEX_OPTION = /^\s*(?:-i\b|--index-url\b|--extra-index-url\b|-f\b|--find-links\b)/m

/** Every exact pin of a requirements.txt, continuation lines joined. */
export function requirementPins(text: string): RequirementPin[] {
  const pins: RequirementPin[] = []
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const start = offset
    let logical = lines[i] ?? ''
    offset += logical.length + 1
    // A trailing backslash continues the requirement on the next line (hashes, mostly).
    while (logical.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      i++
      logical += `\n${lines[i] ?? ''}`
      offset += (lines[i] ?? '').length + 1
    }
    const lead = logical.length - logical.trimStart().length
    const match = PIN.exec(logical.slice(lead))
    if (!match?.[1] || !match[2]) continue
    const versionAt = start + lead + match[0].length - match[2].length
    pins.push({
      name: normalizePypiName(match[1]),
      version: match[2],
      start: versionAt,
      end: versionAt + match[2].length,
      hashed: /(?:^|\s)--hash[=\s]/.test(logical.replace(/(?:^|\s)#.*$/gm, '')),
    })
  }
  return pins
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
    const text = await ctx.fs.read(ctx.lockfile)
    if (text === null || INDEX_OPTION.test(text)) return null
    return ctx.publishTimes.publishedAt(normalizePypiName(name), version, PYPI_API)
  },

  applyStep: editPins,

  // The edit is the whole lockfile update; no tool runs.
  lockfileInstall: () => [],

  // Installing would build source distributions (package code); the fix PR's CI installs.
  fullInstall: () => null,

  checks: () => Promise.resolve([]),
}
