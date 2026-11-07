import type { FixDispatchStep } from '@hinomi/shared'
import { registryFor } from '../registry.js'
import { parseNpmrc, type Npmrc } from '../npmrc.js'
import { isJsonObject, parseJsonFile, stringifyJsonFile, type JsonObject } from '../json-file.js'
import { repoJoin } from '../repo-fs.js'
import type { CheckSpec, EditOutcome, ProjectContext } from './types.js'

// What pnpm, npm, yarn and bun share: package.json manifests, the npm registry, .npmrc and
// package.json scripts as checks.

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

// `^1.2.3`, `~1.2.3`, `1.2.3` and `=1.2.3`: the only specifiers the runner rewrites.
const PLAIN_SPECIFIER = /^(\^|~|=)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The specifier with its version replaced, the range prefix kept; null when not plain. */
export function bumpSpecifier(specifier: string, version: string): string | null {
  const match = PLAIN_SPECIFIER.exec(specifier.trim())
  if (!match) return null
  return `${match[1] ?? ''}${version}`
}

/**
 * manifest_bump for the npm family: in every listed manifest, rewrite the package's entry in
 * dependencies, devDependencies and optionalDependencies (peer ranges are left alone). The
 * whole step is skipped as `manual_specifier` when any entry is not a plain version, so a
 * step never lands half applied.
 */
export async function bumpManifests(
  ctx: ProjectContext,
  step: FixDispatchStep,
): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'manifest_bump') {
    return {
      status: 'failed',
      reason: 'edit_failed',
      detail: `${apply.type} is not a manifest bump`,
    }
  }
  const edits: Array<{ path: string; text: string }> = []
  for (const path of apply.manifests) {
    const text = await ctx.fs.read(path)
    if (text === null) {
      return { status: 'failed', reason: 'edit_failed', detail: `${path} does not exist` }
    }
    let file
    try {
      file = parseJsonFile(text)
    } catch {
      return { status: 'failed', reason: 'edit_failed', detail: `${path} is not valid JSON` }
    }
    let found = false
    for (const field of DEPENDENCY_FIELDS) {
      const deps = file.data[field]
      if (!isJsonObject(deps)) continue
      const current = deps[apply.packageName]
      if (current === undefined) continue
      found = true
      const next = typeof current === 'string' ? bumpSpecifier(current, apply.version) : null
      if (next === null) {
        return {
          status: 'skipped',
          reason: 'manual_specifier',
          detail: `${path} ${field} has ${JSON.stringify(current)}`,
        }
      }
      deps[apply.packageName] = next
    }
    if (!found) {
      return {
        status: 'failed',
        reason: 'edit_failed',
        detail: `${path} does not list ${apply.packageName}`,
      }
    }
    edits.push({ path, text: stringifyJsonFile(file) })
  }
  for (const edit of edits) await ctx.fs.write(edit.path, edit.text)
  return { status: 'edited', files: edits.map((edit) => edit.path) }
}

/** True when an override key targets `packageName`: `pkg`, `pkg@range`, `a>pkg`, `a>pkg@range`. */
export function overrideKeyTargets(key: string, packageName: string): boolean {
  const last = key.slice(key.lastIndexOf('>') + 1)
  return last === packageName || last.startsWith(`${packageName}@`)
}

/**
 * Sets every existing override of `packageName` in `overrides` (nested npm objects too) to
 * `value`. Returns how many entries it changed.
 */
export function updateExistingOverrides(
  overrides: JsonObject,
  packageName: string,
  value: string,
): number {
  let changed = 0
  for (const [key, current] of Object.entries(overrides)) {
    if (overrideKeyTargets(key, packageName)) {
      if (typeof current === 'string') {
        overrides[key] = value
        changed++
      } else if (isJsonObject(current) && typeof current['.'] === 'string') {
        current['.'] = value
        changed++
      }
    } else if (isJsonObject(current)) {
      changed += updateExistingOverrides(current, packageName, value)
    }
  }
  return changed
}

/** Reads and parses a package.json, null when missing or not an object. */
export async function readManifest(ctx: ProjectContext, path: string) {
  const text = await ctx.fs.read(path)
  if (text === null) return null
  try {
    return parseJsonFile(text)
  } catch {
    return null
  }
}

/** The project's .npmrc first, then the repo root's. */
export async function readNpmrcs(ctx: ProjectContext): Promise<Npmrc[]> {
  const paths = [...new Set([repoJoin(ctx.root, '.npmrc'), '.npmrc'])]
  return Promise.all(paths.map(async (path) => parseNpmrc(await ctx.fs.read(path))))
}

export async function npmRegistryPublishedAt(
  ctx: ProjectContext,
  packageName: string,
  version: string,
): Promise<Date | null> {
  const registry = registryFor(packageName, await readNpmrcs(ctx))
  return ctx.publishTimes.publishedAt(packageName, version, registry)
}

// Script names per check, first match wins.
const CHECK_SCRIPTS: Array<[string, string[]]> = [
  ['lint', ['lint']],
  ['typecheck', ['typecheck', 'type-check', 'check-types']],
  ['test', ['test']],
  ['build', ['build']],
]

/** lint, typecheck, test and build from the project's package.json scripts, when defined. */
export async function scriptChecks(ctx: ProjectContext, tool: string): Promise<CheckSpec[]> {
  const manifest = await readManifest(ctx, repoJoin(ctx.root, 'package.json'))
  const scripts = manifest && isJsonObject(manifest.data.scripts) ? manifest.data.scripts : {}
  const checks: CheckSpec[] = []
  for (const [name, candidates] of CHECK_SCRIPTS) {
    const script = candidates.find((candidate) => typeof scripts[candidate] === 'string')
    if (script) {
      checks.push({ name, command: { file: tool, args: ['run', script], env: { CI: 'true' } } })
    }
  }
  return checks
}
