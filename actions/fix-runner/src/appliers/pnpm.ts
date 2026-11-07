import type { FixDispatchStep } from '@hinomi/shared'
import { isMap, isScalar, parse, parseDocument, type Document } from 'yaml'
import { isJsonObject, objectAt, stringifyJsonFile } from '../json-file.js'
import { MINUTES_PER_DAY, type RepoGate } from '../release-age.js'
import { repoJoin } from '../repo-fs.js'
import { parseVersion } from '../semver.js'
import {
  bumpManifests,
  npmRegistryPublishedAt,
  overrideKeyTargets,
  readManifest,
  readNpmrcs,
  scriptChecks,
  updateExistingOverrides,
} from './npm-family.js'
import type { Applier, EditOutcome, ProjectContext } from './types.js'

// pnpm 9, 10 and 11. Overrides go to `overrides` in pnpm-workspace.yaml when the project has
// that file, else to `pnpm.overrides` in the root package.json; an override that already
// exists in either place is updated where it is.

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** `name@version` out of a lockfile key: `/a@1.0.0(peer@2.0.0)` (v6) or `@s/a@1.0.0` (v9). */
export function parsePnpmPackageKey(key: string): { name: string; version: string } | null {
  const trimmed = key.startsWith('/') ? key.slice(1) : key
  const paren = trimmed.indexOf('(')
  const base = paren === -1 ? trimmed : trimmed.slice(0, paren)
  const at = base.lastIndexOf('@')
  if (at <= 0) return null
  const version = base.slice(at + 1)
  return parseVersion(version) ? { name: base.slice(0, at), version } : null
}

/** Every registry version of `packageName` in a pnpm-lock.yaml. */
export function pnpmLockVersions(text: string, packageName: string): string[] {
  const doc = asRecord(parse(text, { maxAliasCount: -1 }))
  const versions = new Set<string>()
  for (const section of [doc.packages, doc.snapshots]) {
    for (const key of Object.keys(asRecord(section))) {
      const parsed = parsePnpmPackageKey(key)
      if (parsed && parsed.name === packageName) versions.add(parsed.version)
    }
  }
  return [...versions]
}

function toMinutes(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null
}

/** Sets existing overrides of the package in the workspace file. Returns the count. */
function updateYamlOverrides(doc: Document, packageName: string, value: string): number {
  const overrides = doc.get('overrides')
  if (!isMap(overrides)) return 0
  let changed = 0
  for (const item of overrides.items) {
    const key = isScalar(item.key) ? String(item.key.value) : null
    if (key !== null && overrideKeyTargets(key, packageName)) {
      if (isScalar(item.value)) item.value.value = value
      else item.value = doc.createNode(value)
      changed++
    }
  }
  return changed
}

async function applyOverride(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome> {
  const { apply } = step
  if (apply.type !== 'override' || apply.field !== 'pnpm.overrides') {
    return { status: 'failed', reason: 'edit_failed', detail: 'pnpm takes pnpm.overrides only' }
  }
  const workspacePath = repoJoin(ctx.root, 'pnpm-workspace.yaml')
  const workspaceText = await ctx.fs.read(workspacePath)
  const workspace = workspaceText === null ? null : parseDocument(workspaceText)
  if (workspace && workspace.errors.length > 0) {
    return { status: 'failed', reason: 'edit_failed', detail: `${workspacePath} is not valid YAML` }
  }
  const manifest = await readManifest(ctx, apply.manifest)
  if (!manifest) {
    return { status: 'failed', reason: 'edit_failed', detail: `${apply.manifest} is not readable` }
  }

  const inWorkspace = workspace ? updateYamlOverrides(workspace, step.packageName, apply.value) : 0
  const pnpmField = manifest.data.pnpm
  const existing =
    isJsonObject(pnpmField) && isJsonObject(pnpmField.overrides) ? pnpmField.overrides : null
  const inManifest = existing ? updateExistingOverrides(existing, step.packageName, apply.value) : 0
  let writeWorkspace = inWorkspace > 0
  let writeManifest = inManifest > 0
  if (!writeWorkspace && !writeManifest) {
    if (workspace) {
      workspace.setIn(['overrides', apply.key], apply.value)
      writeWorkspace = true
    } else {
      objectAt(objectAt(manifest.data, 'pnpm'), 'overrides')[apply.key] = apply.value
      writeManifest = true
    }
  }
  const files: string[] = []
  if (workspace && writeWorkspace) {
    await ctx.fs.write(workspacePath, workspace.toString({ lineWidth: 0 }))
    files.push(workspacePath)
  }
  if (writeManifest) {
    await ctx.fs.write(apply.manifest, stringifyJsonFile(manifest))
    files.push(apply.manifest)
  }
  return { status: 'edited', files }
}

export const pnpmApplier: Applier = {
  packageManager: 'pnpm',
  lockfiles: ['pnpm-lock.yaml'],
  versionCommand: { file: 'pnpm', args: ['--version'] },

  async resolvedVersions(ctx, packageName) {
    const text = await ctx.fs.read(ctx.lockfile)
    return text === null ? [] : pnpmLockVersions(text, packageName)
  },

  async releaseAgeGate(ctx): Promise<RepoGate | null> {
    const workspacePath = repoJoin(ctx.root, 'pnpm-workspace.yaml')
    const workspace = asRecord(parse((await ctx.fs.read(workspacePath)) ?? '') as unknown)
    const exclude = Array.isArray(workspace.minimumReleaseAgeExclude)
      ? workspace.minimumReleaseAgeExclude.filter((e): e is string => typeof e === 'string')
      : []
    const fromWorkspace = toMinutes(workspace.minimumReleaseAge)
    if (fromWorkspace !== null) {
      return { minutes: fromWorkspace, source: 'pnpm-workspace.yaml minimumReleaseAge', exclude }
    }
    for (const rc of await readNpmrcs(ctx)) {
      const minutes = toMinutes(rc.values.get('minimum-release-age'))
      if (minutes !== null) return { minutes, source: '.npmrc minimum-release-age', exclude }
    }
    // pnpm 11 turned the gate on by default (one day); pnpm 10 has it off unless set.
    const major = ctx.version ? parseVersion(ctx.version)?.major : undefined
    if (major !== undefined && major >= 11) {
      return { minutes: MINUTES_PER_DAY, source: 'pnpm default', exclude }
    }
    return null
  },

  publishedAt: npmRegistryPublishedAt,

  applyStep(ctx, step) {
    return step.apply.type === 'override' ? applyOverride(ctx, step) : bumpManifests(ctx, step)
  },

  lockfileInstall() {
    // CI=true makes pnpm default to a frozen lockfile, which is the opposite of the goal here.
    return {
      file: 'pnpm',
      args: ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'],
    }
  },

  fullInstall() {
    return { file: 'pnpm', args: ['install', '--frozen-lockfile'] }
  },

  checks(ctx) {
    return scriptChecks(ctx, 'pnpm')
  },
}
