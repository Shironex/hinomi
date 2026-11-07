import type { FixDispatchStep } from '@hinomi/shared'
import { isJsonObject, objectAt, stringifyJsonFile } from '../json-file.js'
import type { RepoGate } from '../release-age.js'
import { repoJoin } from '../repo-fs.js'
import { parseVersion } from '../semver.js'
import {
  bumpManifests,
  npmRegistryPublishedAt,
  readManifest,
  scriptChecks,
  updateExistingOverrides,
} from './npm-family.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// bun with the text bun.lock (bun 1.2 and later) or the binary bun.lockb, which bun keeps
// writing while it is the project's lockfile. Transitive fixes go to `overrides` in the root
// package.json; bun also reads yarn's `resolutions`, so an entry already there is updated
// where it is.

const VERSION_TIMEOUT_MS = 60_000

/** JSONC to JSON: drops comments and trailing commas, leaving string contents untouched. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i++
    } else if (ch === '/' && text.charAt(i + 1) === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      i++
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** `name` and `version` of `name@version`, scoped names included. */
function splitAtVersion(text: string): { name: string; version: string } | null {
  const at = text.lastIndexOf('@')
  if (at <= 0) return null
  return { name: text.slice(0, at), version: text.slice(at + 1) }
}

/**
 * Every registry version of `packageName` in a bun.lock. A `packages` entry is
 * `["name@version", registry, { dependencies }, integrity]`; workspace, git and file entries
 * carry no plain version and are left out.
 */
export function bunLockVersions(text: string, packageName: string): string[] {
  const doc: unknown = JSON.parse(stripJsonc(text))
  if (!isJsonObject(doc) || !isJsonObject(doc.packages)) return []
  const versions = new Set<string>()
  for (const entry of Object.values(doc.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const split = splitAtVersion(entry[0])
    if (split?.name === packageName && parseVersion(split.version)) versions.add(split.version)
  }
  return [...versions]
}

/** Every version of `packageName` in the tree `bun pm ls --all` prints. */
export function bunListVersions(output: string, packageName: string): string[] {
  const versions = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const item = line.replace(/^[\s│├└─]+/, '').trim()
    const split = splitAtVersion(item)
    if (split?.name === packageName && parseVersion(split.version)) versions.add(split.version)
  }
  return [...versions]
}

async function applyOverride(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'override' || apply.field !== 'overrides') {
    return { status: 'failed', reason: 'edit_failed', detail: 'bun takes overrides only' }
  }
  const manifest = await readManifest(ctx, apply.manifest)
  if (!manifest) {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.manifest} is not readable` }
  }
  let updated = 0
  for (const field of ['overrides', 'resolutions']) {
    const existing = manifest.data[field]
    if (isJsonObject(existing)) {
      updated += updateExistingOverrides(existing, step.packageName, apply.value)
    }
  }
  if (updated === 0) objectAt(manifest.data, 'overrides')[apply.key] = apply.value
  await ctx.fs.write(apply.manifest, stringifyJsonFile(manifest))
  return { status: 'edited', files: [apply.manifest] }
}

/** Drops a TOML comment, keeping `#` inside strings. */
function stripTomlComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

export interface BunInstallSettings {
  minimumReleaseAge: number | null
  minimumReleaseAgeExcludes: string[]
}

/**
 * The two release age settings of a bunfig.toml: `minimumReleaseAge` (seconds) and
 * `minimumReleaseAgeExcludes` under `[install]` or as dotted `install.` keys. Just enough
 * TOML for these: numbers and arrays of strings, arrays over several lines too.
 */
export function readBunfigInstall(text: string): BunInstallSettings {
  const settings: BunInstallSettings = { minimumReleaseAge: null, minimumReleaseAgeExcludes: [] }
  let table = ''
  let pending: { key: string; value: string } | null = null
  const assign = (key: string, value: string) => {
    if (key === 'install.minimumReleaseAge') {
      const number = Number(value.replace(/_/g, ''))
      if (value !== '' && Number.isFinite(number) && number >= 0) {
        settings.minimumReleaseAge = number
      }
    } else if (key === 'install.minimumReleaseAgeExcludes') {
      settings.minimumReleaseAgeExcludes = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)]
        .map((match) => match[1] ?? match[2] ?? '')
        .filter((entry) => entry !== '')
    }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim()
    if (pending) {
      pending.value += ` ${line}`
      if (line.includes(']')) {
        assign(pending.key, pending.value)
        pending = null
      }
      continue
    }
    if (line === '') continue
    const header = /^\[([^[\]]+)\]$/.exec(line)
    if (header?.[1]) {
      table = header[1].trim()
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const name = line
      .slice(0, eq)
      .trim()
      .replace(/^"(.*)"$/, '$1')
    const key = table === '' ? name : `${table}.${name}`
    const value = line.slice(eq + 1).trim()
    if (value.startsWith('[') && !value.includes(']')) pending = { key, value }
    else assign(key, value)
  }
  return settings
}

export const bunApplier: Applier = {
  packageManager: 'bun',
  lockfiles: ['bun.lock', 'bun.lockb'],
  versionCommand: { file: 'bun', args: ['--version'] },

  async resolvedVersions(ctx, packageName) {
    if (ctx.lockfile.endsWith('.lockb')) {
      // The binary lockfile is read through bun itself, which lists it without installing.
      const result = await ctx.exec.run(
        { file: 'bun', args: ['pm', 'ls', '--all'] },
        { cwd: ctx.fs.absolute(ctx.root), timeoutMs: VERSION_TIMEOUT_MS },
      )
      return result.code === 0 ? bunListVersions(result.output, packageName) : []
    }
    const text = await ctx.fs.read(ctx.lockfile)
    if (text === null) return []
    try {
      return bunLockVersions(text, packageName)
    } catch {
      return []
    }
  },

  async releaseAgeGate(ctx): Promise<RepoGate | null> {
    // bun reads the bunfig.toml of the folder it runs in; the gate is off unless set.
    const text = await ctx.fs.read(repoJoin(ctx.root, 'bunfig.toml'))
    if (text === null) return null
    const settings = readBunfigInstall(text)
    if (settings.minimumReleaseAge === null) return null
    return {
      minutes: Math.ceil(settings.minimumReleaseAge / 60),
      source: 'bunfig.toml minimumReleaseAge',
      exclude: settings.minimumReleaseAgeExcludes,
    }
  },

  publishedAt: npmRegistryPublishedAt,

  applyStep(ctx, step) {
    return step.apply.type === 'override' ? applyOverride(ctx, step) : bumpManifests(ctx, step)
  },

  lockfileInstall() {
    // --lockfile-only resolves without installing; --ignore-scripts keeps the project's own
    // lifecycle scripts off too (bun never runs untrusted dependencies' scripts).
    return { file: 'bun', args: ['install', '--lockfile-only', '--ignore-scripts'] }
  },

  fullInstall() {
    return { file: 'bun', args: ['install', '--frozen-lockfile'] }
  },

  checks(ctx) {
    return scriptChecks(ctx, 'bun')
  },
}
