import { describe, expect, it } from 'vitest'
import { runApply, runChecks } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  argv,
  daysAgo,
  deps,
  dispatch,
  fakeExec,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  step,
  type PmHandler,
} from './testing.js'

// The reusable workflow runs apply with the checks deferred, so the patch and its hash are
// final before any install script runs, then the check step on the tree apply left.

const TIMES = mockPublishTimes({ 'plover-parse@1.4.1': daysAgo(30) })

const ploverBump = step(1, {
  packageName: 'plover-parse',
  to: '1.4.1',
  apply: {
    type: 'manifest_bump',
    manifests: ['apps/web/package.json'],
    packageName: 'plover-parse',
    version: '1.4.1',
  },
})

function lockfileWritingPm(root: string): PmHandler {
  return async ({ command }) => {
    if (command.args[0] === '--version') return { output: '10.34.9\n' }
    if (command.args.includes('--lockfile-only')) {
      const fs = nodeRepoFs(root)
      const lock = (await fs.read('pnpm-lock.yaml')) ?? ''
      await fs.write('pnpm-lock.yaml', lock.replace('1.2.0', '1.4.1'))
    }
    return {}
  }
}

describe('deferred checks', () => {
  it('captures the patch without running any check, then the check step runs them', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root))
    const value = dispatch([ploverBump])
    const applied = await runApply({ ...inputs(value), deferChecks: true }, deps(root, exec, TIMES))
    expect(applied.result.checksMode).toBe('full')
    expect(applied.result.checks).toEqual([])
    expect(exec.calls.map(argv)).not.toContain('pnpm install --frozen-lockfile')
    expect(applied.patch).toContain('"plover-parse": "^1.4.1"')

    const checked = await runChecks(inputs(value), deps(root, exec, TIMES), applied.result)
    expect(exec.calls.map(argv)).toContain('pnpm install --frozen-lockfile')
    expect(checked.checks.map((check) => check.name)).toEqual([
      'lint',
      'typecheck',
      'test',
      'build',
    ])
    expect(checked.patch).toEqual(applied.result.patch)
    expect(checked.steps).toEqual(applied.result.steps)
  })

  it('records a failed full install and skips the checks', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const base = lockfileWritingPm(root)
    const exec = fakeExec((call) =>
      argv(call) === 'pnpm install --frozen-lockfile'
        ? { code: 1, output: 'ERR_PNPM_OUTDATED_LOCKFILE\n' }
        : base(call),
    )
    const value = dispatch([ploverBump])
    const applied = await runApply({ ...inputs(value), deferChecks: true }, deps(root, exec, TIMES))
    const checked = await runChecks(inputs(value), deps(root, exec, TIMES), applied.result)
    expect(checked.install.status).toBe('failed')
    expect(checked.install.output).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
    expect(checked.checks.every((check) => check.status === 'skipped')).toBe(true)
  })

  it('does nothing in install mode or without a patch', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root))
    const value = dispatch([ploverBump], { checks: 'install' })
    const applied = await runApply({ ...inputs(value), deferChecks: true }, deps(root, exec, TIMES))
    const calls = exec.calls.length
    const checked = await runChecks(inputs(value), deps(root, exec, TIMES), applied.result)
    expect(checked).toBe(applied.result)
    expect(exec.calls.length).toBe(calls)
  })

  it('refuses a result from another run', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const exec = fakeExec(lockfileWritingPm(root))
    const value = dispatch([ploverBump])
    const applied = await runApply({ ...inputs(value), deferChecks: true }, deps(root, exec, TIMES))
    await expect(
      runChecks(inputs(value), deps(root, exec, TIMES), { ...applied.result, runId: 'run-8' }),
    ).rejects.toThrow('The result is for run run-8')
  })
})
