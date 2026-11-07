import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDetect } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import { commitAll, dispatch, fixtureRepo, git, inputs, step } from './testing.js'
import { planToolchains, toolchainOutputs } from './toolchain.js'

// The detect step names every toolchain the dispatch's projects need, so the reusable workflow
// sets each one up before the apply step.

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

describe('runDetect toolchains', () => {
  it('names every package manager among the projects, with Node and pnpm settings', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const fs = nodeRepoFs(root)
    mkdirSync(join(root, 'tools/cli'), { recursive: true })
    await fs.write('tools/cli/Cargo.toml', '[package]\nname = "cli"\nversion = "0.1.0"\n')
    await fs.write('tools/cli/Cargo.lock', 'version = 4\n')
    await fs.write('.nvmrc', '24\n')
    git(root, 'add', '-A')
    commitAll(root)
    const cargoStep = step(2, {
      ecosystem: 'crates.io',
      packageName: 'serde',
      to: '1.0.220',
      packageManager: 'cargo',
      lockfile: 'tools/cli/Cargo.lock',
      workspaces: ['cli'],
      apply: {
        type: 'lockfile_update',
        tool: 'cargo',
        packageName: 'serde',
        from: ['1.0.200'],
        to: '1.0.220',
      },
    })
    const detected = await runDetect(inputs(dispatch([ploverBump, cargoStep])), fs)
    expect(detected.packageManager).toBe('pnpm')
    expect(detected.problems).toEqual([])
    expect(toolchainOutputs(detected.toolchains)).toEqual({
      package_managers: 'pnpm,cargo',
      setup_node: 'true',
      node_version_file: '.nvmrc',
      setup_pnpm: 'true',
      pnpm_version: '',
      pnpm_package_json: 'package.json',
      setup_yarn: 'false',
      yarn_version: '',
      setup_bun: 'false',
      bun_version: '',
      setup_rust: 'true',
      rust_root: 'tools/cli',
    })
  })

  it('reports a project whose lockfile is missing and sets up the rest', async () => {
    const root = await fixtureRepo('pnpm-workspace')
    const npmStep = step(2, {
      packageName: 'plover-parse',
      to: '1.4.1',
      packageManager: 'npm',
      lockfile: 'site/package-lock.json',
      apply: {
        type: 'manifest_bump',
        manifests: ['site/package.json'],
        packageName: 'plover-parse',
        version: '1.4.1',
      },
    })
    const detected = await runDetect(inputs(dispatch([ploverBump, npmStep])), nodeRepoFs(root))
    expect(detected.toolchains.managers).toEqual(['pnpm'])
    expect(detected.problems).toEqual(['site: no lockfile in site'])
  })

  it('falls back to defaults when nothing names a version', async () => {
    const root = await fixtureRepo('npm-overrides')
    const fs = nodeRepoFs(root)
    const toolchains = await planToolchains(fs, [
      { root: '.', packageManager: 'pnpm' },
      { root: 'web', packageManager: 'bun' },
      { root: 'docs', packageManager: 'yarn' },
    ])
    expect(toolchains).toEqual({
      managers: ['pnpm', 'bun', 'yarn'],
      node: true,
      nodeVersionFile: '',
      pnpm: { version: '10', packageJsonFile: 'package.json' },
      yarn: { version: '' },
      bun: { version: 'latest' },
      rust: null,
    })
  })

  it('reads engines.node from package.json when there is no version file', async () => {
    const root = await fixtureRepo('npm-overrides')
    const fs = nodeRepoFs(root)
    await fs.write('package.json', JSON.stringify({ name: 'x', engines: { node: '>=24' } }))
    const toolchains = await planToolchains(fs, [{ root: '.', packageManager: 'npm' }])
    expect(toolchains.nodeVersionFile).toBe('package.json')
  })
})
