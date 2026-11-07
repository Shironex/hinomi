import type { FixDispatchStep } from '@hinomi/shared'
import { parse } from 'yaml'
import { isJsonObject, objectAt, stringifyJsonFile, type JsonObject } from '../json-file.js'
import type { RepoGate } from '../release-age.js'
import { repoJoin } from '../repo-fs.js'
import { atLeast, parseVersion } from '../semver.js'
import { parsePackageManagerField } from '../detect.js'
import type { Npmrc } from '../npmrc.js'
import { registryFor } from '../registry.js'
import { bumpManifests, npmRegistryPublishedAt, readManifest, scriptChecks } from './npm-family.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// yarn classic (1.x) and berry (2 and later) with yarn.lock. Transitive fixes go to
// `resolutions` in the root package.json. The two lines differ in the lockfile format, the
// install flags and the release age gate (berry only), so each call picks the line first.

export type YarnLine = 'classic' | 'berry'

/** First berry release whose `npmMinimalAgeGate` defaults to one day instead of off. */
const BERRY_DEFAULT_GATE_SINCE = '4.15.0'
const BERRY_DEFAULT_GATE_MINUTES = 1_440

function lineOfVersion(version: string | null): YarnLine | null {
  const major = version ? parseVersion(version)?.major : undefined
  if (major === undefined) return null
  return major >= 2 ? 'berry' : 'classic'
}

/**
 * The yarn line of a project. The version yarn itself printed wins (it follows `yarnPath`
 * and Corepack); without it the `packageManager` field, a `.yarnrc.yml` or a berry lockfile
 * header mean berry, anything else classic.
 */
export async function yarnLine(ctx: ProjectContext): Promise<YarnLine> {
  const fromTool = lineOfVersion(ctx.version)
  if (fromTool) return fromTool
  for (const folder of [...new Set([ctx.root, '.'])]) {
    const manifest = await readManifest(ctx, repoJoin(folder, 'package.json'))
    const declared = parsePackageManagerField(manifest?.data.packageManager)
    const fromField = declared?.name === 'yarn' ? lineOfVersion(declared.version) : null
    if (fromField) return fromField
  }
  if (await ctx.fs.exists(repoJoin(ctx.root, '.yarnrc.yml'))) return 'berry'
  return isBerryLock((await ctx.fs.read(ctx.lockfile)) ?? '') ? 'berry' : 'classic'
}

/** Berry lockfiles are YAML with a `__metadata` entry; classic ones never have it. */
export function isBerryLock(text: string): boolean {
  return /^__metadata:/m.test(text)
}

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, '$1')

/** `name` and the rest of `name@rest`, scoped names included. */
function splitDescriptor(descriptor: string): { name: string; rest: string } | null {
  const at = descriptor.indexOf('@', 1)
  if (at <= 0) return null
  return { name: descriptor.slice(0, at), rest: descriptor.slice(at + 1) }
}

/** The package a classic descriptor resolves, following `alias@npm:real@range`. */
function classicName(descriptor: string): string | null {
  const split = splitDescriptor(descriptor)
  if (!split) return null
  if (split.rest.startsWith('npm:')) return splitDescriptor(split.rest.slice(4))?.name ?? null
  return split.name
}

function classicVersions(text: string, packageName: string): string[] {
  const versions = new Set<string>()
  let matches = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue
    if (!/^\s/.test(line)) {
      const first = line.replace(/:$/, '').split(',')[0] ?? ''
      matches = classicName(unquote(first)) === packageName
      continue
    }
    const version = matches ? /^ {2}version "?([^"\s]+)"?$/.exec(line)?.[1] : undefined
    if (version && parseVersion(version)) versions.add(version)
  }
  return [...versions]
}

function berryVersions(text: string, packageName: string): string[] {
  const doc: unknown = parse(text, { maxAliasCount: -1 })
  if (!isJsonObject(doc)) return []
  const versions = new Set<string>()
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata' || !isJsonObject(entry)) continue
    const resolution = typeof entry.resolution === 'string' ? entry.resolution : ''
    const split = splitDescriptor(resolution)
    // Registry and patched registry packages only; git, file and workspace entries are not.
    if (!split || split.name !== packageName) continue
    if (!(split.rest.startsWith('npm:') || split.rest.startsWith('patch:'))) continue
    const version = typeof entry.version === 'string' ? entry.version : ''
    if (parseVersion(version)) versions.add(version)
  }
  return [...versions]
}

/** Every registry version of `packageName` in a yarn.lock, classic or berry. */
export function yarnLockVersions(text: string, packageName: string): string[] {
  return isBerryLock(text) ? berryVersions(text, packageName) : classicVersions(text, packageName)
}

/**
 * True when a `resolutions` key targets `packageName`: `pkg`, `**\/pkg`, `parent/pkg`,
 * `parent/**\/pkg`, each optionally with `@range` or `@npm:range` on the last package.
 */
export function resolutionKeyTargets(key: string, packageName: string): boolean {
  const parts = key.split('/')
  let last = parts.at(-1) ?? ''
  const beforeLast = parts.at(-2)
  if (beforeLast?.startsWith('@')) last = `${beforeLast}/${last}`
  return last === packageName || last.startsWith(`${packageName}@`)
}

async function applyResolution(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'override' || apply.field !== 'resolutions') {
    return { status: 'failed', reason: 'edit_failed', detail: 'yarn takes resolutions only' }
  }
  const manifest = await readManifest(ctx, apply.manifest)
  if (!manifest) {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.manifest} is not readable` }
  }
  const existing: JsonObject | null = isJsonObject(manifest.data.resolutions)
    ? manifest.data.resolutions
    : null
  let updated = 0
  for (const key of Object.keys(existing ?? {})) {
    if (existing && resolutionKeyTargets(key, step.packageName)) {
      existing[key] = apply.value
      updated++
    }
  }
  if (updated === 0) objectAt(manifest.data, 'resolutions')[apply.key] = apply.value
  await ctx.fs.write(apply.manifest, stringifyJsonFile(manifest))
  return { status: 'edited', files: [apply.manifest] }
}

const DURATION_MINUTES: Record<string, number> = {
  ms: 1 / 60_000,
  s: 1 / 60,
  m: 1,
  h: 60,
  d: 1_440,
  w: 10_080,
}

/** A berry duration (`1w`, `3d`, `90m`, or a bare number of minutes) in minutes. */
export function parseYarnDuration(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const match = /^(\d*\.?\d+)(ms|s|m|h|d|w)?$/.exec(value.trim())
  if (!match?.[1]) return null
  return Number(match[1]) * (match[2] ? (DURATION_MINUTES[match[2]] ?? 1) : 1)
}

/** `pkg@npm:1.2.3` as `pkg@1.2.3`, the form the release age exclusions compare. */
function normalizePreapproved(entry: string): string {
  return entry.replace(/(.)@npm:/, '$1@')
}

async function readYarnrc(ctx: ProjectContext, path: string): Promise<Record<string, unknown>> {
  try {
    const doc: unknown = parse((await ctx.fs.read(path)) ?? '')
    return isJsonObject(doc) ? doc : {}
  } catch {
    return {}
  }
}

/** The project's .yarnrc.yml first, then the repo root's, the order yarn layers them in. */
async function readYarnrcs(ctx: ProjectContext): Promise<Array<Record<string, unknown>>> {
  const paths = [...new Set([repoJoin(ctx.root, '.yarnrc.yml'), '.yarnrc.yml'])]
  return Promise.all(paths.map((path) => readYarnrc(ctx, path)))
}

/** The registries of a .yarnrc.yml in the shape `registryFor` reads. */
export function yarnrcRegistries(rc: Record<string, unknown>): Npmrc {
  const values = new Map<string, string>()
  if (typeof rc.npmRegistryServer === 'string') values.set('registry', rc.npmRegistryServer)
  if (isJsonObject(rc.npmScopes)) {
    for (const [scope, config] of Object.entries(rc.npmScopes)) {
      if (isJsonObject(config) && typeof config.npmRegistryServer === 'string') {
        values.set(`@${scope}:registry`, config.npmRegistryServer)
      }
    }
  }
  return { values, lists: new Map() }
}

async function berryGate(ctx: ProjectContext): Promise<RepoGate | null> {
  const files = await readYarnrcs(ctx)
  const preapproved = files.find((rc) => Array.isArray(rc.npmPreapprovedPackages))
  const exclude = (
    Array.isArray(preapproved?.npmPreapprovedPackages) ? preapproved.npmPreapprovedPackages : []
  )
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizePreapproved)
  for (const rc of files) {
    const minutes = parseYarnDuration(rc.npmMinimalAgeGate)
    if (minutes !== null) return { minutes, source: '.yarnrc.yml npmMinimalAgeGate', exclude }
  }
  if (ctx.version && atLeast(ctx.version, BERRY_DEFAULT_GATE_SINCE)) {
    return { minutes: BERRY_DEFAULT_GATE_MINUTES, source: 'yarn default', exclude }
  }
  return null
}

export const yarnApplier: Applier = {
  packageManager: 'yarn',
  lockfiles: ['yarn.lock'],
  versionCommand: { file: 'yarn', args: ['--version'] },

  async resolvedVersions(ctx, packageName) {
    const text = await ctx.fs.read(ctx.lockfile)
    if (text === null) return []
    try {
      return yarnLockVersions(text, packageName)
    } catch {
      return []
    }
  },

  async releaseAgeGate(ctx) {
    // yarn classic has no release age setting.
    return (await yarnLine(ctx)) === 'berry' ? berryGate(ctx) : null
  },

  async publishedAt(ctx, packageName, version) {
    // Berry reads its registries from .yarnrc.yml and ignores .npmrc; classic reads .npmrc.
    if ((await yarnLine(ctx)) === 'classic') {
      return npmRegistryPublishedAt(ctx, packageName, version)
    }
    const registry = registryFor(packageName, (await readYarnrcs(ctx)).map(yarnrcRegistries))
    return ctx.publishTimes.publishedAt(packageName, version, registry)
  },

  applyStep(ctx, step) {
    return step.apply.type === 'override' ? applyResolution(ctx, step) : bumpManifests(ctx, step)
  },

  async lockfileInstall(ctx) {
    if ((await yarnLine(ctx)) === 'classic') {
      // Classic has no lockfile only mode: a full install with every lifecycle script off.
      return {
        file: 'yarn',
        args: ['install', '--ignore-scripts', '--non-interactive', '--no-progress'],
      }
    }
    // update-lockfile (berry 3 and later) resolves and fetches only, skipping the link and
    // build steps, so no script runs. Berry 2 has no such mode and rejects the flag, so its
    // install fails and is reported rather than run with scripts. Berry defaults to an
    // immutable lockfile on CI, hence --no-immutable.
    return { file: 'yarn', args: ['install', '--mode=update-lockfile', '--no-immutable'] }
  },

  fullInstall(ctx) {
    // Sync here, so the version yarn printed decides; a yarn that printed none fails anyway.
    return lineOfVersion(ctx.version) === 'classic'
      ? { file: 'yarn', args: ['install', '--frozen-lockfile', '--non-interactive'] }
      : { file: 'yarn', args: ['install', '--immutable'] }
  },

  checks(ctx) {
    return scriptChecks(ctx, 'yarn')
  },
}
