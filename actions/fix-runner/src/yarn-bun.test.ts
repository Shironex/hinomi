import type { FixDispatchStep } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  bunApplier,
  bunListVersions,
  bunLockVersions,
  readBunfigInstall,
  stripJsonc,
} from './appliers/bun.js'
import type { ProjectContext } from './appliers/types.js'
import {
  parseYarnDuration,
  resolutionKeyTargets,
  yarnApplier,
  yarnLine,
  yarnLockVersions,
  yarnrcRegistries,
} from './appliers/yarn.js'
import { registryFor } from './registry.js'
import { nodeExec } from './exec.js'
import { runApply } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  FIXTURES,
  NOW,
  argv,
  commitAll,
  daysAgo,
  deps,
  dispatch,
  fakeExec,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  readJson,
  readText,
  step,
  type PmHandler,
} from './testing.js'

// The yarn (classic and berry) and bun appliers: their readers, and the whole pipeline with
// the package manager faked at the exec boundary and the registry mocked, as for pnpm and npm.

const TIMES = mockPublishTimes({
  'plover-parse@1.4.1': daysAgo(30),
  'wren-util@2.2.0': daysAgo(40),
  'heron-log@1.8.2': daysAgo(20),
})

type Manager = 'yarn' | 'bun'

function steps(manager: Manager, lockfile: string, manifests: string[]): FixDispatchStep[] {
  const field = manager === 'yarn' ? 'resolutions' : 'overrides'
  const base = { packageManager: manager, lockfile }
  return [
    step(1, {
      ...base,
      packageName: 'plover-parse',
      to: '1.4.1',
      id: `bump:${manager}:plover-parse`,
      apply: { type: 'manifest_bump', manifests, packageName: 'plover-parse', version: '1.4.1' },
    }),
    step(2, {
      ...base,
      packageName: 'wren-util',
      from: ['2.0.4', '2.1.0'],
      to: '2.2.0',
      id: `override:${manager}:wren-util`,
      apply: {
        type: 'override',
        manifest: 'package.json',
        field,
        key: 'wren-util',
        value: '2.2.0',
      },
    }),
    step(3, {
      ...base,
      packageName: 'heron-log',
      from: ['1.8.0'],
      to: '1.8.2',
      id: `override:${manager}:heron-log`,
      apply: {
        type: 'override',
        manifest: 'package.json',
        field,
        key: 'heron-log',
        value: '1.8.2',
      },
    }),
  ]
}

/**
 * A package manager that prints `version`, rewrites the lockfile on its lockfile install
 * (the command `isLockfileInstall` recognises) and fails it when `fail` returns a message.
 */
function fakePm(
  root: string,
  options: {
    version: string
    lockfile: string
    isLockfileInstall: (args: string[]) => boolean
    fail?: () => string | null
    list?: string
  },
): PmHandler {
  return async ({ command }) => {
    if (command.args[0] === '--version') return { output: `${options.version}\n` }
    if (command.args.join(' ') === 'pm ls --all') return { output: options.list ?? '' }
    if (options.isLockfileInstall(command.args)) {
      const message = options.fail?.() ?? null
      if (message) return { code: 1, output: `resolving\n${message}\n` }
      const fs = nodeRepoFs(root)
      const bytes = (await fs.readBytes(options.lockfile)) ?? Buffer.alloc(0)
      await fs.writeBytes(options.lockfile, Buffer.concat([bytes, Buffer.from('\n')]))
    }
    return {}
  }
}

describe('runApply with yarn classic', () => {
  const classicSteps = steps('yarn', 'yarn.lock', ['package.json'])
  const isLockfileInstall = (args: string[]) => args.includes('--ignore-scripts')

  it('bumps, updates the existing resolution in place and adds a new one', async () => {
    const root = await fixtureRepo('yarn-classic')
    const exec = fakeExec(
      fakePm(root, { version: '1.22.22', lockfile: 'yarn.lock', isLockfileInstall }),
    )
    const { result } = await runApply(inputs(dispatch(classicSteps)), deps(root, exec, TIMES))
    const manifest = readJson(root, 'package.json')
    expect(manifest.dependencies).toEqual({ 'plover-parse': '^1.4.1', 'tern-stream': '^3.0.1' })
    expect(manifest.resolutions).toEqual({ '**/heron-log': '1.8.2', 'wren-util': '2.2.0' })
    expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied', 'applied'])
    expect(result.packageManager).toBe('yarn')
    expect(result.patch?.files).toEqual(['package.json', 'yarn.lock'])
    expect(exec.calls.map(argv)).toEqual([
      'yarn --version',
      'yarn install --ignore-scripts --non-interactive --no-progress',
      'yarn install --frozen-lockfile --non-interactive',
      'yarn run lint',
      'yarn run test',
    ])
    // Classic has no release age setting, so Hinomi's floor applies.
    expect(result.releaseAge.map((r) => [r.gateDays, r.gateSource])).toEqual([
      [7, 'hinomi'],
      [7, 'hinomi'],
      [7, 'hinomi'],
    ])
  })

  it('bisects a failed install down to the step that broke it', async () => {
    const root = await fixtureRepo('yarn-classic')
    const fail = () =>
      readText(root, 'package.json').includes('"wren-util"')
        ? 'error Couldn\'t find any versions for "wren-util" that matches "2.2.0"'
        : null
    const exec = fakeExec(
      fakePm(root, { version: '1.22.22', lockfile: 'yarn.lock', isLockfileInstall, fail }),
    )
    const { result } = await runApply(
      inputs(dispatch(classicSteps, { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      ['failed', 'install_failed'],
      ['applied', null],
    ])
    expect(result.steps[1]?.detail).toContain('Couldn\'t find any versions for "wren-util"')
    expect(readJson(root, 'package.json').resolutions).toEqual({ '**/heron-log': '1.8.2' })
    expect(result.install.status).toBe('ok')
  })
})

describe('runApply with yarn berry', () => {
  const berrySteps = steps('yarn', 'yarn.lock', ['apps/console/package.json'])
  const isLockfileInstall = (args: string[]) => args.includes('--mode=update-lockfile')

  it('bumps a workspace, updates a range scoped resolution and skips git entries', async () => {
    const root = await fixtureRepo('yarn-berry')
    const exec = fakeExec(
      fakePm(root, { version: '4.18.1', lockfile: 'yarn.lock', isLockfileInstall }),
    )
    const times = mockPublishTimes(timesAt(30))
    const { result } = await runApply(inputs(dispatch(berrySteps)), deps(root, exec, times))
    expect(readJson(root, 'apps/console/package.json').dependencies).toEqual({
      'plover-parse': '~1.4.1',
      'tern-stream': '^3.0.1',
    })
    expect(readJson(root, 'package.json').resolutions).toEqual({
      'heron-log@npm:^1.7.0': '1.8.2',
      'wren-util': '2.2.0',
    })
    // The git resolution of wren-util (9.9.9) does not count as a fixed registry version.
    expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied', 'applied'])
    expect(exec.calls.map(argv)).toEqual([
      'yarn --version',
      'yarn install --mode=update-lockfile --no-immutable',
      'yarn install --immutable',
      'yarn run typecheck',
      'yarn run build',
    ])
    expect(result.releaseAge[0]).toMatchObject({
      gateDays: 14,
      gateSource: '.yarnrc.yml npmMinimalAgeGate',
      status: 'clear',
    })
    // Publish times come from the registry .yarnrc.yml names, not from .npmrc.
    expect(times.requests[0]).toBe('https://npm.example.dev/plover-parse@1.4.1')
  })

  it('holds back a version inside the npmMinimalAgeGate of .yarnrc.yml', async () => {
    const root = await fixtureRepo('yarn-berry')
    const exec = fakeExec(
      fakePm(root, { version: '4.18.1', lockfile: 'yarn.lock', isLockfileInstall }),
    )
    const { result } = await runApply(
      inputs(dispatch(berrySteps)),
      deps(root, exec, mockPublishTimes(timesAt(10))),
    )
    expect(result.steps.map((s) => s.reason)).toEqual(['too_new', 'too_new', 'too_new'])
    expect(result.releaseAge[0]).toMatchObject({
      gateDays: 14,
      gateSource: '.yarnrc.yml npmMinimalAgeGate',
      eligibleAt: '2026-11-11T10:00:00.000Z',
    })
    expect(result.patch).toBeNull()
    expect(exec.calls.map(argv)).toEqual(['yarn --version'])
  })
})

describe('runApply with bun', () => {
  it('bumps, updates the resolution bun reads and adds an override (bun.lock)', async () => {
    const root = await fixtureRepo('bun-text')
    const exec = fakeExec(
      fakePm(root, {
        version: '1.4.4',
        lockfile: 'bun.lock',
        isLockfileInstall: (args) => args.includes('--lockfile-only'),
      }),
    )
    const { result } = await runApply(
      inputs(dispatch(steps('bun', 'bun.lock', ['package.json']))),
      deps(root, exec, mockPublishTimes(timesAt(30))),
    )
    const manifest = readJson(root, 'package.json')
    expect(manifest.dependencies).toEqual({ 'plover-parse': '^1.4.1', 'tern-stream': '^3.0.1' })
    expect(manifest.resolutions).toEqual({ 'heron-log': '1.8.2' })
    expect(manifest.overrides).toEqual({ 'wren-util': '2.2.0' })
    expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied', 'applied'])
    expect(result.patch?.files).toEqual(['bun.lock', 'package.json'])
    expect(exec.calls.map(argv)).toEqual([
      'bun --version',
      'bun install --lockfile-only --ignore-scripts',
      'bun install --frozen-lockfile',
      'bun run check-types',
      'bun run test',
    ])
    expect(result.releaseAge[0]).toMatchObject({
      gateDays: 14,
      gateSource: 'bunfig.toml minimumReleaseAge',
    })
  })

  it('holds back a version inside the bunfig.toml gate', async () => {
    const root = await fixtureRepo('bun-text')
    const exec = fakeExec(
      fakePm(root, { version: '1.4.4', lockfile: 'bun.lock', isLockfileInstall: () => false }),
    )
    const { result } = await runApply(
      inputs(dispatch(steps('bun', 'bun.lock', ['package.json']))),
      deps(root, exec, mockPublishTimes(timesAt(10))),
    )
    expect(result.steps.map((s) => s.reason)).toEqual(['too_new', 'too_new', 'too_new'])
    expect(result.steps[0]?.detail).toContain('14 day gate from bunfig.toml minimumReleaseAge')
    expect(exec.calls.map(argv)).toEqual(['bun --version'])
  })

  it('bisects a failed install and keeps the rest', async () => {
    const root = await fixtureRepo('bun-text')
    const fail = () =>
      readText(root, 'package.json').includes('"plover-parse": "^1.4.1"')
        ? 'error: No version matching "^1.4.1" found for specifier "plover-parse"'
        : null
    const exec = fakeExec(
      fakePm(root, {
        version: '1.4.4',
        lockfile: 'bun.lock',
        isLockfileInstall: (args) => args.includes('--lockfile-only'),
        fail,
      }),
    )
    const { result } = await runApply(
      inputs(dispatch(steps('bun', 'bun.lock', ['package.json']), { checks: 'install' })),
      deps(root, exec, mockPublishTimes(timesAt(30))),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['failed', 'install_failed'],
      ['applied', null],
      ['applied', null],
    ])
    expect(readJson(root, 'package.json').dependencies).toMatchObject({
      'plover-parse': '^1.2.0',
    })
  })

  it('reads a binary bun.lockb through bun and patches it as binary', async () => {
    const root = await fixtureRepo('bun-binary', async (dir) => {
      await nodeRepoFs(dir).writeBytes('bun.lockb', Buffer.from([0x23, 0x21, 0x00, 0xff, 0x01]))
    })
    const list = [
      `${root} node_modules`,
      '├── plover-parse@1.2.0',
      '│   └── wren-util@2.1.0',
      '├── tern-stream@3.0.1',
      '│   └── wren-util@2.0.4',
      '└── heron-log@1.8.2',
    ].join('\n')
    const exec = fakeExec(
      fakePm(root, {
        version: '1.4.4',
        lockfile: 'bun.lockb',
        isLockfileInstall: (args) => args.includes('--lockfile-only'),
        list,
      }),
    )
    const { result, patch } = await runApply(
      inputs(dispatch(steps('bun', 'bun.lockb', ['package.json']), { checks: 'install' })),
      deps(root, exec, mockPublishTimes(timesAt(30))),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      ['applied', null],
      ['skipped', 'already_fixed'],
    ])
    expect(result.patch?.files).toEqual(['bun.lockb', 'package.json'])
    expect(patch).toContain('GIT binary patch')
    expect(exec.calls.filter((c) => argv(c) === 'bun pm ls --all').length).toBeGreaterThan(0)
  })
})

function timesAt(days: number): Record<string, Date> {
  return {
    'plover-parse@1.4.1': daysAgo(days),
    'wren-util@2.2.0': daysAgo(days),
    'heron-log@1.8.2': daysAgo(days),
  }
}

async function contextFor(fixture: string, version: string | null, lockfile = 'yarn.lock') {
  const root = await fixtureRepo(fixture)
  const ctx: ProjectContext = {
    fs: nodeRepoFs(root),
    root: '.',
    lockfile,
    version,
    publishTimes: TIMES,
    exec: nodeExec({ env: {} }),
    now: NOW,
  }
  return { root, ctx }
}

describe('yarn lines and gates', () => {
  it('takes the line from the version yarn printed, else from the checkout', async () => {
    const { root, ctx } = await contextFor('yarn-berry', null)
    expect(await yarnLine(ctx)).toBe('berry')
    expect(await yarnLine({ ...ctx, version: '1.22.22' })).toBe('classic')
    const classic = await contextFor('yarn-classic', null)
    expect(await yarnLine(classic.ctx)).toBe('classic')
    expect(await yarnApplier.releaseAgeGate(classic.ctx)).toBeNull()
    const options = { repoGate: null, steps: [] }
    expect(await yarnApplier.lockfileInstall(ctx, options)).toMatchObject({
      args: ['install', '--mode=update-lockfile', '--no-immutable'],
    })
    expect(await yarnApplier.lockfileInstall(classic.ctx, options)).toMatchObject({
      args: ['install', '--ignore-scripts', '--non-interactive', '--no-progress'],
    })

    // No packageManager field and no .yarnrc.yml: the berry lockfile header decides.
    const fs = nodeRepoFs(root)
    const manifest = readJson(root, 'package.json')
    delete manifest.packageManager
    await fs.write('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.write('.yarnrc.yml', '')
    commitAll(root)
    expect(await yarnLine(ctx)).toBe('berry')
  })

  it("applies berry's one day default from 4.15.0 when .yarnrc.yml sets no gate", async () => {
    const { root, ctx } = await contextFor('yarn-berry', '4.15.0')
    await nodeRepoFs(root).write('.yarnrc.yml', 'nodeLinker: node-modules\n')
    expect(await yarnApplier.releaseAgeGate(ctx)).toEqual({
      minutes: 1_440,
      source: 'yarn default',
      exclude: [],
    })
    expect(await yarnApplier.releaseAgeGate({ ...ctx, version: '4.14.1' })).toBeNull()
  })

  it('reads the gate and the preapproved packages from .yarnrc.yml', async () => {
    const { ctx } = await contextFor('yarn-berry', '4.18.1')
    expect(await yarnApplier.releaseAgeGate(ctx)).toEqual({
      minutes: 20_160,
      source: '.yarnrc.yml npmMinimalAgeGate',
      exclude: ['@kestrel/*'],
    })
  })

  it('reads the bunfig.toml gate in seconds and its exclusions', async () => {
    const { ctx } = await contextFor('bun-text', '1.4.4', 'bun.lock')
    expect(await bunApplier.releaseAgeGate(ctx)).toEqual({
      minutes: 20_160,
      source: 'bunfig.toml minimumReleaseAge',
      exclude: ['@kestrel/kit', 'typescript@5.4.5'],
    })
    const binary = await contextFor('bun-binary', '1.4.4', 'bun.lockb')
    expect(await bunApplier.releaseAgeGate(binary.ctx)).toBeNull()
  })
})

describe('yarn and bun readers', () => {
  it('reads classic and berry yarn.lock, aliases in, git entries out', () => {
    const classic = readText(FIXTURES, 'yarn-classic/yarn.lock')
    expect(yarnLockVersions(classic, 'wren-util').sort()).toEqual(['2.0.4', '2.1.0'])
    expect(yarnLockVersions(classic, 'heron-log')).toEqual(['1.8.0'])
    expect(yarnLockVersions(classic, 'tern-stream')).toEqual(['3.0.1'])
    expect(yarnLockVersions(classic, 'kite-glob')).toEqual([])
    const alias = 'plover@npm:plover-parse@^1.0.0:\n  version "1.3.0"\n'
    expect(yarnLockVersions(alias, 'plover-parse')).toEqual(['1.3.0'])

    const berry = readText(FIXTURES, 'yarn-berry/yarn.lock')
    expect(yarnLockVersions(berry, 'wren-util')).toEqual(['2.1.0'])
    expect(yarnLockVersions(berry, 'plover-parse')).toEqual(['1.2.0'])
    expect(yarnLockVersions(berry, 'kestrel-admin')).toEqual([])
  })

  it('recognises resolution keys for a package', () => {
    for (const key of ['wren-util', '**/wren-util', 'a/wren-util', 'a/**/wren-util@^2']) {
      expect(resolutionKeyTargets(key, 'wren-util')).toBe(true)
    }
    expect(resolutionKeyTargets('wren-util@npm:^2.0.0', 'wren-util')).toBe(true)
    expect(resolutionKeyTargets('**/@kestrel/kit', '@kestrel/kit')).toBe(true)
    expect(resolutionKeyTargets('@kestrel/kit@1.x', '@kestrel/kit')).toBe(true)
    expect(resolutionKeyTargets('wren-utils', 'wren-util')).toBe(false)
    expect(resolutionKeyTargets('wren-util/heron-log', 'wren-util')).toBe(false)
  })

  it('maps the registries of a .yarnrc.yml, scopes included', () => {
    const rc = yarnrcRegistries({
      npmRegistryServer: 'https://npm.example.dev',
      npmScopes: { kestrel: { npmRegistryServer: 'https://npm-kestrel.example.dev/' } },
    })
    expect(registryFor('@kestrel/kit', [rc])).toBe('https://npm-kestrel.example.dev/')
    expect(registryFor('wren-util', [rc])).toBe('https://npm.example.dev/')
    expect(registryFor('wren-util', [yarnrcRegistries({})])).toBe('https://registry.npmjs.org/')
  })

  it('reads berry durations in minutes', () => {
    expect(parseYarnDuration('1w')).toBe(10_080)
    expect(parseYarnDuration('3d')).toBe(4_320)
    expect(parseYarnDuration('12h')).toBe(720)
    expect(parseYarnDuration('90')).toBe(90)
    expect(parseYarnDuration(1440)).toBe(1440)
    expect(parseYarnDuration('1.5d')).toBe(2_160)
    expect(parseYarnDuration('120s')).toBe(2)
    expect(parseYarnDuration('soon')).toBeNull()
    expect(parseYarnDuration(-1)).toBeNull()
    expect(parseYarnDuration(undefined)).toBeNull()
  })

  it('reads bun.lock as JSONC and the tree bun pm ls prints', () => {
    const lock = readText(FIXTURES, 'bun-text/bun.lock')
    expect(bunLockVersions(lock, 'wren-util').sort()).toEqual(['2.0.4', '2.1.0'])
    expect(bunLockVersions(lock, 'kite-glob')).toEqual([])
    expect(stripJsonc('{ "a": "x // y", /* c */ "b": [1, 2,], }')).toBe(
      '{ "a": "x // y",  "b": [1, 2] }',
    )
    const tree =
      '/w node_modules\n├── @kestrel/kit@0.3.0\n│   └── wren-util@2.0.4\n└── wren-util@2.1.0\n'
    expect(bunListVersions(tree, 'wren-util')).toEqual(['2.0.4', '2.1.0'])
    expect(bunListVersions(tree, '@kestrel/kit')).toEqual(['0.3.0'])
  })

  it('reads the release age settings of bunfig.toml in both TOML forms', () => {
    expect(readBunfigInstall(readText(FIXTURES, 'bun-text/bunfig.toml'))).toEqual({
      minimumReleaseAge: 1_209_600,
      minimumReleaseAgeExcludes: ['@kestrel/kit', 'typescript@5.4.5'],
    })
    const dotted =
      'install.minimumReleaseAge = 259_200\ninstall.minimumReleaseAgeExcludes = ["a#b"]\n'
    expect(readBunfigInstall(dotted)).toEqual({
      minimumReleaseAge: 259_200,
      minimumReleaseAgeExcludes: ['a#b'],
    })
    expect(readBunfigInstall('[run]\nminimumReleaseAge = 5\n').minimumReleaseAge).toBeNull()
  })
})
