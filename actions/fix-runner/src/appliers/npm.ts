import type { FixDispatchStep } from '@hinomi/shared'
import { isJsonObject, objectAt, stringifyJsonFile, type JsonObject } from '../json-file.js'
import { MINUTES_PER_DAY, minutesSince, type RepoGate } from '../release-age.js'
import { atLeast } from '../semver.js'
import {
  bumpManifests,
  npmRegistryPublishedAt,
  readManifest,
  readNpmrcs,
  scriptChecks,
  updateExistingOverrides,
} from './npm-family.js'
import type { Applier, EditOutcome, InstallOptions, ProjectContext } from './types.js'

// npm with package-lock.json (or npm-shrinkwrap.json), lockfile versions 1 to 3. Overrides
// go to `overrides` in the root package.json.

/** First npm release that reads min-release-age; older ones ignore it silently. */
const NPM_MIN_RELEASE_AGE_SINCE = '11.10.0'

/** Every version of `packageName` in a package-lock.json. */
export function npmLockVersions(text: string, packageName: string): string[] {
  const doc: unknown = JSON.parse(text)
  if (!isJsonObject(doc)) return []
  const versions = new Set<string>()
  const suffix = `node_modules/${packageName}`
  if (isJsonObject(doc.packages)) {
    for (const [path, entry] of Object.entries(doc.packages)) {
      if (!(path === suffix || path.endsWith(`/${suffix}`))) continue
      if (isJsonObject(entry) && typeof entry.version === 'string' && entry.link !== true) {
        versions.add(entry.version)
      }
    }
  }
  // Lockfile v1 nests `dependencies`.
  const walk = (deps: unknown) => {
    if (!isJsonObject(deps)) return
    for (const [name, entry] of Object.entries(deps)) {
      if (!isJsonObject(entry)) continue
      if (name === packageName && typeof entry.version === 'string') versions.add(entry.version)
      walk(entry.dependencies)
    }
  }
  if (!isJsonObject(doc.packages)) walk(doc.dependencies)
  return [...versions]
}

async function applyOverride(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'override' || apply.field !== 'overrides') {
    return { status: 'failed', reason: 'edit_failed', detail: 'npm takes overrides only' }
  }
  const manifest = await readManifest(ctx, apply.manifest)
  if (!manifest) {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.manifest} is not readable` }
  }
  const existing: JsonObject | null = isJsonObject(manifest.data.overrides)
    ? manifest.data.overrides
    : null
  const updated = existing ? updateExistingOverrides(existing, step.packageName, apply.value) : 0
  if (updated === 0) objectAt(manifest.data, 'overrides')[apply.key] = apply.value
  await ctx.fs.write(apply.manifest, stringifyJsonFile(manifest))
  return { status: 'edited', files: [apply.manifest] }
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export const npmApplier: Applier = {
  packageManager: 'npm',
  lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
  versionCommand: { file: 'npm', args: ['--version'] },

  async resolvedVersions(ctx, packageName) {
    const text = await ctx.fs.read(ctx.lockfile)
    if (text === null) return []
    try {
      return npmLockVersions(text, packageName)
    } catch {
      return []
    }
  },

  async releaseAgeGate(ctx): Promise<RepoGate | null> {
    for (const rc of await readNpmrcs(ctx)) {
      const exclude = rc.lists.get('min-release-age-exclude') ?? []
      const days = toNumber(rc.values.get('min-release-age'))
      if (days !== null) {
        return { minutes: days * MINUTES_PER_DAY, source: '.npmrc min-release-age', exclude }
      }
      const before = rc.values.get('before')
      const date = before ? new Date(before) : null
      if (date && !Number.isNaN(date.getTime())) {
        return { minutes: minutesSince(date, ctx.now), source: '.npmrc before', exclude }
      }
    }
    return null
  },

  publishedAt: npmRegistryPublishedAt,

  applyStep(ctx, step) {
    return step.apply.type === 'override' ? applyOverride(ctx, step) : bumpManifests(ctx, step)
  },

  lockfileInstall(ctx, { repoGate }: InstallOptions) {
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
    // An npm older than 11.10 ignores min-release-age, so the gate is passed as --before.
    const ignoresGate = !ctx.version || !atLeast(ctx.version, NPM_MIN_RELEASE_AGE_SINCE)
    if (repoGate?.source === '.npmrc min-release-age' && ignoresGate) {
      const before = new Date(ctx.now.getTime() - repoGate.minutes * 60_000)
      args.push(`--before=${before.toISOString()}`)
    }
    return { file: 'npm', args }
  },

  fullInstall() {
    return { file: 'npm', args: ['ci', '--no-audit', '--no-fund'] }
  },

  checks(ctx) {
    return scriptChecks(ctx, 'npm')
  },
}
