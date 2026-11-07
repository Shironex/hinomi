import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixPayloadError, parseFixResult } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { FixRunnerError } from './errors.js'
import { runApply, runDetect } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  FIXTURES,
  REPO,
  argv,
  commitAll,
  daysAgo,
  deps,
  dispatch,
  fakeExec,
  fixtureRepo,
  git,
  inputs,
  mockPublishTimes,
  passingPm,
  readJson,
  readText,
  step,
  type PmHandler,
} from './testing.js'

const TIMES = mockPublishTimes({
  'plover-parse@1.4.1': daysAgo(30),
  'wren-util@2.2.0': daysAgo(40),
  'heron-log@1.8.2': daysAgo(20),
  'tern-stream@3.0.4': daysAgo(25),
})

const ploverBump = step(1, {
  packageName: 'plover-parse',
  to: '1.4.1',
  workspaces: ['apps/web', 'apps/api'],
  apply: {
    type: 'manifest_bump',
    manifests: ['apps/web/package.json', 'apps/api/package.json'],
    packageName: 'plover-parse',
    version: '1.4.1',
  },
})

const wrenOverride = step(2, {
  packageName: 'wren-util',
  from: ['2.1.0'],
  to: '2.2.0',
  apply: {
    type: 'override',
    manifest: 'package.json',
    field: 'pnpm.overrides',
    key: 'wren-util',
    value: '2.2.0',
  },
})

const heronOverride = step(3, {
  packageName: 'heron-log',
  from: ['1.8.0'],
  to: '1.8.2',
  apply: {
    type: 'override',
    manifest: 'package.json',
    field: 'pnpm.overrides',
    key: 'heron-log',
    value: '1.8.2',
  },
})

/** A pnpm whose lockfile install rewrites the lockfile, like the real one does. */
function lockfileWritingPm(root: string, fail?: () => string | null): PmHandler {
  return async ({ command }) => {
    if (command.args[0] === '--version') return { output: '10.34.9\n' }
    if (command.args.includes('--lockfile-only')) {
      const message = fail?.() ?? null
      if (message) return { code: 1, output: `Progress: resolved 12\n${message}\n` }
      const fs = nodeRepoFs(root)
      const lock = (await fs.read('pnpm-lock.yaml')) ?? ''
      await fs.write('pnpm-lock.yaml', lock.replace('1.2.0', '1.4.1'))
    }
    return {}
  }
}

describe('runApply with pnpm', () => {
  it('bumps a direct dependency in every listed manifest and keeps the range prefix', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root))
    const { result, patch } = await runApply(
      inputs(dispatch([ploverBump])),
      deps(root, exec, TIMES),
    )

    expect(readJson(root, 'apps/web/package.json').dependencies).toMatchObject({
      'plover-parse': '^1.4.1',
      '@kestrel/kit': 'workspace:*',
    })
    expect(readJson(root, 'apps/api/package.json').devDependencies).toEqual({
      'plover-parse': '~1.4.1',
    })
    expect(result.steps).toEqual([
      {
        id: ploverBump.id,
        status: 'applied',
        reason: null,
        detail: null,
        files: ['apps/web/package.json', 'apps/api/package.json'],
      },
    ])
    expect(result.patch?.files).toEqual([
      'apps/api/package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
    ])
    expect(patch).toContain('+    "plover-parse": "^1.4.1"')
    expect(result.packageManager).toBe('pnpm')
    expect(result.packageManagerVersion).toBe('10.34.9')
    expect(result.baseSha).toMatch(/^[a-f0-9]{40}$/)
    expect(() => parseFixResult(result)).not.toThrow()

    // Every command is an argument array; the order is version, lockfile install, frozen
    // install, then the checks the root package.json defines (type-check maps to typecheck).
    expect(exec.calls.map(argv)).toEqual([
      'pnpm --version',
      'pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts',
      'pnpm install --frozen-lockfile',
      'pnpm run lint',
      'pnpm run type-check',
      'pnpm run test',
      'pnpm run build',
    ])
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['lint', 'passed'],
      ['typecheck', 'passed'],
      ['test', 'passed'],
      ['build', 'passed'],
    ])
    expect(exec.calls.find((c) => argv(c) === 'pnpm run test')?.command.env).toEqual({ CI: 'true' })
    expect(result.install.status).toBe('ok')
  })

  it('adds a transitive override to pnpm-workspace.yaml and updates an existing one in place', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(passingPm())
    const { result } = await runApply(
      inputs(dispatch([wrenOverride, heronOverride], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    const yaml = readText(root, 'pnpm-workspace.yaml')
    expect(yaml).toContain('# Pinned while heron-log 2 settles.\n  heron-log@<2.0.0: 1.8.2\n')
    expect(yaml).toContain('  wren-util: 2.2.0\n')
    expect(yaml.match(/heron-log/g)).toHaveLength(2)
    expect(yaml).toContain('# Refuse releases younger than 14 days.')
    expect(readText(root, 'package.json')).toBe(
      readFileSync(join(FIXTURES, 'pnpm-workspace/package.json'), 'utf8'),
    )
    expect(result.steps.map((s) => [s.status, s.files])).toEqual([
      ['applied', ['pnpm-workspace.yaml']],
      ['applied', ['pnpm-workspace.yaml']],
    ])
    expect(result.patch?.files).toEqual(['pnpm-workspace.yaml'])
    expect(result.checks).toEqual([])
    expect(exec.calls.map(argv)).toEqual([
      'pnpm --version',
      'pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts',
    ])
  })

  it('writes pnpm.overrides in package.json when there is no pnpm-workspace.yaml', async () => {
    const root = await fixtureRepo('pnpm-package-overrides')
    const exec = fakeExec(passingPm())
    const { result } = await runApply(
      inputs(dispatch([wrenOverride, heronOverride], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(readJson(root, 'package.json').pnpm).toEqual({
      overrides: { 'heron-log': '1.8.2', 'wren-util': '2.2.0' },
    })
    expect(readText(root, 'package.json')).toMatch(/\n {2}"pnpm": \{\n {4}"overrides"/)
    expect(result.steps.every((s) => s.status === 'applied')).toBe(true)
  })

  it('holds back a version inside the repo gate and records the eligible date', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const times = mockPublishTimes({
      'plover-parse@1.4.1': daysAgo(10),
      'wren-util@2.2.0': daysAgo(3),
      'heron-log@1.8.2': null,
    })
    const exec = fakeExec(passingPm())
    const { result } = await runApply(
      inputs(dispatch([ploverBump, wrenOverride, heronOverride])),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['skipped', 'too_new'],
      ['skipped', 'too_new'],
      ['skipped', 'too_new'],
    ])
    expect(result.releaseAge).toEqual([
      {
        stepId: ploverBump.id,
        packageName: 'plover-parse',
        version: '1.4.1',
        publishedAt: daysAgo(10).toISOString(),
        gateDays: 14,
        gateSource: 'pnpm-workspace.yaml minimumReleaseAge',
        status: 'too_new',
        eligibleAt: '2026-11-11T10:00:00.000Z',
      },
      expect.objectContaining({ packageName: 'wren-util', status: 'too_new', gateDays: 14 }),
      expect.objectContaining({ packageName: 'heron-log', status: 'unknown', eligibleAt: null }),
    ])
    expect(result.steps[0]?.detail).toContain('eligible on 2026-11-11')
    expect(result.patch).toBeNull()
    expect(result.install.status).toBe('skipped')
    // Nothing was applied, so no install and no checks ran.
    expect(exec.calls.map(argv)).toEqual(['pnpm --version'])
    expect(readText(root, 'pnpm-workspace.yaml')).not.toContain('wren-util')
  })

  it('skips steps the lockfile already satisfies or does not have', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const already = step(1, {
      packageName: 'heron-log',
      from: ['1.7.0'],
      to: '1.8.0',
      apply: { ...heronOverride.apply, value: '1.8.0' } as typeof heronOverride.apply,
    })
    const missing = step(2, {
      packageName: 'kite-glob',
      from: ['0.3.0'],
      to: '0.3.2',
      apply: {
        type: 'override',
        manifest: 'package.json',
        field: 'pnpm.overrides',
        key: 'kite-glob',
        value: '0.3.2',
      },
    })
    const exec = fakeExec(passingPm())
    const { result } = await runApply(inputs(dispatch([already, missing])), deps(root, exec, TIMES))
    expect(result.steps.map((s) => [s.status, s.reason, s.detail])).toEqual([
      ['skipped', 'already_fixed', 'pnpm-lock.yaml already resolves 1.8.0'],
      ['skipped', 'not_in_lockfile', 'kite-glob is not in pnpm-lock.yaml'],
    ])
    expect(result.patch).toBeNull()
  })

  it('skips a manifest bump whose specifier is not a plain version', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const fs = nodeRepoFs(root)
    const web = readJson(root, 'apps/web/package.json')
    ;(web.dependencies as Record<string, string>)['plover-parse'] = 'catalog:'
    await fs.write('apps/web/package.json', `${JSON.stringify(web, null, 2)}\n`)
    commitAll(root)
    const exec = fakeExec(passingPm())
    const { result } = await runApply(inputs(dispatch([ploverBump])), deps(root, exec, TIMES))
    expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'manual_specifier' })
    // The api manifest was not touched either: a step never lands half applied.
    expect(readJson(root, 'apps/api/package.json').devDependencies).toEqual({
      'plover-parse': '~1.2.0',
    })
  })

  it('bisects a failed install down to the step that broke it and keeps the rest', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const fs = nodeRepoFs(root)
    const pm = lockfileWritingPm(root, () => {
      const yaml = readText(root, 'pnpm-workspace.yaml')
      return yaml.includes('wren-util:')
        ? ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for wren-util@2.2.0'
        : null
    })
    const exec = fakeExec(pm)
    const { result } = await runApply(
      inputs(dispatch([ploverBump, wrenOverride, heronOverride], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(result.steps.map((s) => [s.id, s.status, s.reason])).toEqual([
      [ploverBump.id, 'applied', null],
      [wrenOverride.id, 'failed', 'install_failed'],
      [heronOverride.id, 'applied', null],
    ])
    expect(result.steps[1]?.detail).toBe(
      'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for wren-util@2.2.0',
    )
    const yaml = (await fs.read('pnpm-workspace.yaml')) ?? ''
    expect(yaml).not.toContain('wren-util')
    expect(yaml).toContain('heron-log@<2.0.0: 1.8.2')
    expect(readJson(root, 'apps/web/package.json').dependencies).toMatchObject({
      'plover-parse': '^1.4.1',
    })
    expect(result.install.status).toBe('ok')
    expect(result.patch?.files).toEqual([
      'apps/api/package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ])
    const installs = exec.calls.filter((c) => c.command.args.includes('--lockfile-only'))
    // all, baseline, [plover, wren], [plover], [plover, heron]
    expect(installs).toHaveLength(5)
  })

  it('blames no step when the install fails without any of them', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root, () => 'ERR_PNPM_FETCH_404 registry down'))
    const { result, patch } = await runApply(
      inputs(dispatch([ploverBump, wrenOverride])),
      deps(root, exec, TIMES),
    )
    expect(result.steps.map((s) => s.reason)).toEqual(['install_failed', 'install_failed'])
    expect(result.steps[0]?.detail).toBe(
      'install fails without any step: ERR_PNPM_FETCH_404 registry down',
    )
    expect(result.install.status).toBe('failed')
    expect(result.install.output).toContain('ERR_PNPM_FETCH_404')
    expect(patch).toBeNull()
    expect(result.checks).toEqual([])
  })

  it('records failed checks with their output tail and leaves the patch as it was', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const base = lockfileWritingPm(root)
    const exec = fakeExec(async (call) => {
      if (argv(call) === 'pnpm run test') {
        return { code: 1, output: 'FAIL src/a.test.ts\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123\n' }
      }
      if (argv(call) === 'pnpm run build') {
        // A check that edits a manifest cannot change the captured patch.
        await nodeRepoFs(root).write('apps/web/package.json', '{}\n')
        return { timedOut: true, code: null }
      }
      return base(call)
    })
    const { result, patch } = await runApply(
      inputs(dispatch([ploverBump])),
      deps(root, exec, TIMES),
    )
    const test = result.checks.find((c) => c.name === 'test')
    expect(test).toMatchObject({ status: 'failed', command: 'pnpm run test' })
    expect(test?.output).toBe('FAIL src/a.test.ts\ntoken ***')
    expect(result.checks.find((c) => c.name === 'build')?.status).toBe('timeout')
    expect(patch).toContain('"plover-parse": "^1.4.1"')
  })

  it('runs only the checks the checks input names', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root))
    const { result } = await runApply(
      inputs(dispatch([ploverBump], { checks: 'install' }), 'lint,typecheck'),
      deps(root, exec, TIMES),
    )
    expect(result.checksMode).toBe('full')
    expect(result.checks.map((c) => c.name)).toEqual(['lint', 'typecheck'])
  })

  it('keeps files outside the dependency allowlist out of the patch', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const fs = nodeRepoFs(root)
    await fs.write('build.mjs', 'export {}\n')
    git(root, 'add', 'build.mjs')
    commitAll(root)
    const lines: string[] = []
    const base = lockfileWritingPm(root)
    // An "install" that also rewrites a tracked file that is not a dependency file.
    const exec = fakeExec(async (call) => {
      if (call.command.args.includes('--lockfile-only')) await fs.write('build.mjs', 'evil()\n')
      return base(call)
    })
    const { result, patch } = await runApply(
      inputs(dispatch([ploverBump], { checks: 'install' })),
      deps(root, exec, TIMES, lines),
    )
    expect(result.patch?.files).not.toContain('build.mjs')
    expect(patch).not.toContain('evil()')
    expect(lines).toContain('warning: Left out of the patch path=build.mjs')
  })

  it('fails the steps of a project whose package manager does not match the dispatch', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const npmStep = { ...ploverBump, packageManager: 'npm' as const, lockfile: 'package-lock.json' }
    const exec = fakeExec(passingPm())
    const { result } = await runApply(inputs(dispatch([npmStep])), deps(root, exec, TIMES))
    expect(result.steps[0]).toMatchObject({ status: 'failed', reason: 'edit_failed' })
    expect(result.steps[0]?.detail).toContain('package manager')
    expect(exec.calls).toEqual([])
  })
})

describe('runApply with npm', () => {
  const ploverNpm = {
    ...ploverBump,
    packageManager: 'npm' as const,
    lockfile: 'package-lock.json',
    id: 'manifest_bump:npm:plover-parse:1.4.1:package-lock.json',
    apply: {
      type: 'manifest_bump' as const,
      manifests: ['package.json'],
      packageName: 'plover-parse',
      version: '1.4.1',
    },
  }
  const heronNpm = {
    ...heronOverride,
    packageManager: 'npm' as const,
    lockfile: 'package-lock.json',
    id: 'override:npm:heron-log:1.8.2:package-lock.json',
    apply: {
      type: 'override' as const,
      manifest: 'package.json',
      field: 'overrides' as const,
      key: 'heron-log',
      value: '1.8.2',
    },
  }
  const wrenNpm = {
    ...wrenOverride,
    packageManager: 'npm' as const,
    lockfile: 'package-lock.json',
    from: ['2.0.4', '2.1.0'],
    id: 'override:npm:wren-util:2.2.0:package-lock.json',
    apply: {
      type: 'override' as const,
      manifest: 'package.json',
      field: 'overrides' as const,
      key: 'wren-util',
      value: '2.2.0',
    },
  }

  it('bumps, updates the nested override in place and adds a new one', async () => {
    const root = await fixtureRepo('npm-overrides')
    const exec = fakeExec(passingPm('11.12.0'))
    const { result } = await runApply(
      inputs(dispatch([ploverNpm, heronNpm, wrenNpm])),
      deps(root, exec, TIMES),
    )
    const manifest = readJson(root, 'package.json')
    expect(manifest.dependencies).toEqual({ 'plover-parse': '^1.4.1', 'tern-stream': '^3.0.1' })
    expect(manifest.overrides).toEqual({
      'tern-stream': { 'heron-log': '1.8.2' },
      'wren-util': '2.2.0',
    })
    expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied', 'applied'])
    expect(result.packageManager).toBe('npm')
    expect(exec.calls.map(argv)).toEqual([
      'npm --version',
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
      'npm ci --no-audit --no-fund',
      'npm run test',
      'npm run build',
    ])
    // .npmrc sets 3 days, Hinomi's floor of 7 wins.
    expect(result.releaseAge.map((r) => [r.gateDays, r.gateSource])).toEqual([
      [7, 'hinomi'],
      [7, 'hinomi'],
      [7, 'hinomi'],
    ])
  })

  it('passes min-release-age as --before to an npm that ignores it', async () => {
    const root = await fixtureRepo('npm-overrides')
    await nodeRepoFs(root).write('.npmrc', 'min-release-age=10\n')
    commitAll(root)
    const exec = fakeExec(passingPm('10.9.8'))
    const { result } = await runApply(
      inputs(dispatch([ploverNpm], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(result.releaseAge[0]).toMatchObject({
      gateDays: 10,
      gateSource: '.npmrc min-release-age',
    })
    expect(exec.calls.map(argv)).toContain(
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --before=2026-10-28T10:00:00.000Z',
    )
  })
})

describe('dispatch validation', () => {
  const fixture = (name: string) => readFileSync(join(FIXTURES, 'dispatches', name), 'utf8')
  const run = async (plan: string, extra: Partial<ReturnType<typeof inputs>> = {}) => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(passingPm())
    return runApply(
      { plan, encoding: 'json', runId: '', repository: REPO, checks: 'auto', ...extra },
      deps(root, exec, TIMES),
    ).finally(() => expect(exec.calls).toEqual([]))
  }

  it('refuses an unknown dispatch schema before anything else', async () => {
    await expect(run(fixture('unsupported-schema.json'))).rejects.toMatchObject({
      name: 'FixPayloadError',
      code: 'unsupported_version',
    })
  })

  it('refuses a step whose version carries a range or shell syntax', async () => {
    const error = await run(fixture('range-target.json')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FixPayloadError)
    expect(error).toMatchObject({ code: 'malformed' })
    expect((error as Error).message).toContain('steps.0.apply.version')
  })

  it('refuses a manifest path outside the repo', async () => {
    await expect(run(fixture('path-escape.json'))).rejects.toMatchObject({ code: 'malformed' })
  })

  it('refuses a dispatch for another repo and a run id that does not match', async () => {
    const plan = JSON.stringify(dispatch([]))
    await expect(run(plan, { repository: 'kestrel-co/other' })).rejects.toBeInstanceOf(
      FixRunnerError,
    )
    await expect(run(plan, { runId: 'run-8' })).rejects.toThrow('run_id')
  })

  it('refuses gzip that is not base64 and gzip that inflates past the cap', async () => {
    await expect(run('%%%', { encoding: 'gzip-base64' })).rejects.toMatchObject({
      code: 'malformed',
    })
    const { gzipSync } = await import('node:zlib')
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 32)).toString('base64')
    await expect(run(bomb, { encoding: 'gzip-base64' })).rejects.toMatchObject({
      code: 'malformed',
    })
  })

  it('accepts a gzip plus base64 dispatch', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const { gzipSync } = await import('node:zlib')
    const plan = gzipSync(JSON.stringify(dispatch([ploverBump]))).toString('base64')
    const detected = await runDetect(
      { plan, encoding: 'gzip-base64', runId: 'run-7', repository: REPO },
      nodeRepoFs(root),
    )
    expect(detected).toMatchObject({
      packageManager: 'pnpm',
      packageManagerVersion: '10.34.9',
      lockfile: 'pnpm-lock.yaml',
      root: '.',
      problem: '',
    })
  })

  it('refuses a checkout with local changes', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    await nodeRepoFs(root).write('package.json', '{}\n')
    const exec = fakeExec(passingPm())
    await expect(runApply(inputs(dispatch([ploverBump])), deps(root, exec, TIMES))).rejects.toThrow(
      'local changes',
    )
  })
})
