import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFixResult } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { main } from './main.js'
import { REPO, dispatch, fixtureRepo, step } from './testing.js'

function outputsOf(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8')
  const outputs: Record<string, string> = {}
  for (const match of text.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[match[1] ?? ''] = match[3] ?? ''
  }
  return outputs
}

describe('main', () => {
  it('runs detect and names the package manager for the toolchain setup', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const out = join(mkdtempSync(join(tmpdir(), 'hinomi-out-')), 'out')
    const code = await main({
      env: {
        GITHUB_WORKSPACE: root,
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: out,
        INPUT_STEP: 'detect',
        INPUT_PLAN: JSON.stringify(dispatch([])),
      },
      write: () => {},
      fetch: () => Promise.reject(new Error('no network in tests')),
    })
    expect(code).toBe(0)
    expect(outputsOf(out)).toMatchObject({
      package_manager: 'pnpm',
      package_manager_version: '10.34.9',
      lockfile: 'pnpm-lock.yaml',
      project_root: '.',
      agent_needed: 'false',
      artifact_name: 'hinomi-fix-run-7',
      package_managers: '',
    })
  })

  it('writes the result file and outputs when nothing can be applied', async () => {
    const root = await fixtureRepo('npm-overrides')
    const out = join(mkdtempSync(join(tmpdir(), 'hinomi-out-')), 'out')
    const missing = step(1, {
      packageName: 'kite-glob',
      to: '0.3.2',
      packageManager: 'npm',
      lockfile: 'package-lock.json',
      apply: {
        type: 'override',
        manifest: 'package.json',
        field: 'overrides',
        key: 'kite-glob',
        value: '0.3.2',
      },
    })
    const lines: string[] = []
    const code = await main({
      // The only real command besides git is `npm --version`; the step is skipped before
      // anything is installed.
      env: {
        GITHUB_WORKSPACE: root,
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: out,
        INPUT_PLAN: JSON.stringify(dispatch([missing])),
        INPUT_RUN_ID: 'run-7',
        PATH: process.env.PATH,
      },
      write: (line) => lines.push(line),
      fetch: () => Promise.reject(new Error('no network in tests')),
    })
    expect(code).toBe(0)
    const outputs = outputsOf(out)
    expect(outputs.has_changes).toBe('false')
    expect(outputs.patch_path).toBe('')
    const result = parseFixResult(JSON.parse(readFileSync(outputs.result_path ?? '', 'utf8')))
    expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'not_in_lockfile' })
    expect(outputs.result_path).toBe(join(root, '.hinomi', 'hinomi-result.json'))
  })

  it('fails and flags a rejected dispatch', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const out = join(mkdtempSync(join(tmpdir(), 'hinomi-out-')), 'out')
    const lines: string[] = []
    const code = await main({
      env: {
        GITHUB_WORKSPACE: root,
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: out,
        INPUT_PLAN: 'not json',
      },
      write: (line) => lines.push(line),
      fetch: () => Promise.reject(new Error('no network in tests')),
    })
    expect(code).toBe(1)
    expect(outputsOf(out)).toEqual({ has_changes: 'false', rejected: 'true' })
    expect(lines).toEqual(['::error::The plan input is not JSON'])
  })
})
