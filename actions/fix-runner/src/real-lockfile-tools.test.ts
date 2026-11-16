import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FixDispatchStep } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { APPLIERS, type Applier, type StepPackageManager } from './appliers/index.js'
import { composerLockPackages } from './appliers/composer.js'
import { parseGoMod } from './appliers/go.js'
import { uvLockPackages } from './appliers/uv.js'
import { nodeExec } from './exec.js'
import { runApply, type RunnerDeps } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  NOW,
  daysAgo,
  dispatch,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  readText,
  silentLogger,
  step,
  storedZip,
} from './testing.js'

// The real go, uv and composer against registries this test writes to a temp folder: a
// file:// Go module proxy, a folder of wheels (and one source distribution whose setup.py
// leaves a marker if it ever runs), and an inline composer package repository with scripts
// that leave a marker. Nothing reaches the network. Each test is skipped when its tool is not
// on PATH (GitHub's Ubuntu runners ship go, php and composer; CI sets up uv) and on Windows,
// where the action never runs.

const OLD = daysAgo(30)

function available(file: string, args = ['--version']): boolean {
  if (process.platform === 'win32') return false
  return spawnSync(file, args, { stdio: 'ignore' }).status === 0
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `hinomi-runner-${name}-`))
}

function writeFile(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

/** The fixture registries are not the public ones, so publish times come from the mock. */
function withMockedRegistry(manager: StepPackageManager): ReadonlyMap<StepPackageManager, Applier> {
  const applier = APPLIERS.get(manager)
  if (!applier) throw new Error(`no ${manager} applier`)
  return new Map([
    [
      manager,
      {
        ...applier,
        publishedAt: (ctx, name, version) => ctx.publishTimes.publishedAt(name, version, 'fixture'),
      },
    ],
  ])
}

function runnerDeps(
  root: string,
  env: Record<string, string>,
  times: Record<string, Date>,
  manager: StepPackageManager,
): RunnerDeps {
  return {
    fs: nodeRepoFs(root),
    exec: nodeExec({ env }),
    publishTimes: mockPublishTimes(times),
    log: silentLogger(),
    now: () => NOW,
    appliers: withMockedRegistry(manager),
    searchPath: env.PATH,
  }
}

function toolStep(
  order: number,
  tool: 'go' | 'uv' | 'composer',
  lockfile: string,
  packageName: string,
  from: string,
  to: string,
): FixDispatchStep {
  return step(order, {
    ecosystem: tool,
    packageManager: tool,
    lockfile,
    relationship: 'transitive',
    packageName,
    from: [from],
    to,
    level: 'patch',
    apply: { type: 'lockfile_update', tool, packageName, from: [from], to },
  })
}

const baseEnv = () => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? homedir() })

// ---------------------------------------------------------------------------
// go

/** A file:// module proxy: list, .info, .mod and .zip of each version. */
function goProxy(modules: Record<string, Record<string, string[]>>): string {
  const proxy = tempDir('goproxy')
  for (const [path, versions] of Object.entries(modules)) {
    const base = join(proxy, path, '@v')
    writeFile(
      join(base, 'list'),
      `${Object.keys(versions)
        .map((v) => `v${v}`)
        .join('\n')}\n`,
    )
    for (const [version, requires] of Object.entries(versions)) {
      const mod = [
        `module ${path}`,
        '',
        'go 1.21',
        ...requires.map((r) => `require ${r}`),
        '',
      ].join('\n')
      writeFile(
        join(base, `v${version}.info`),
        JSON.stringify({ Version: `v${version}`, Time: '2026-01-01T00:00:00Z' }),
      )
      writeFile(join(base, `v${version}.mod`), mod)
      writeFile(join(base, `v${version}.zip`), storedZip({ [`${path}@v${version}/go.mod`]: mod }))
    }
  }
  return proxy
}

describe('real go get', () => {
  it.skipIf(!available('go', ['version']))(
    'moves a direct and an indirect module in go.mod and go.sum, and bisects out a missing version',
    async () => {
      const proxy = goProxy({
        'example.dev/heron/codec': {
          '1.4.0': ['example.dev/wren/net v0.3.1'],
          '1.4.3': ['example.dev/wren/net v0.3.1'],
          '1.4.9': ['example.dev/wren/net v0.3.1'],
        },
        'example.dev/wren/net': { '0.3.1': [], '0.3.2': [] },
        'example.dev/tern/time': { '0.8.1': [] },
      })
      const env = {
        ...baseEnv(),
        GOPROXY: `file://${proxy}`,
        GOSUMDB: 'off',
        GOMODCACHE: tempDir('gomodcache'),
        GOFLAGS: '-modcacherw',
        GOCACHE: tempDir('gocache'),
      }
      const root = await fixtureRepo('real-go', (dir) => {
        // go.sum for the starting versions, as a real repo commits it.
        const r = spawnSync(
          'go',
          ['get', 'example.dev/heron/codec@v1.4.0', 'example.dev/tern/time@v0.8.1'],
          { cwd: dir, env: { ...env, GOTOOLCHAIN: 'local' }, encoding: 'utf8' },
        )
        return r.status === 0 ? Promise.resolve() : Promise.reject(new Error(r.stderr))
      })
      const steps = [
        toolStep(1, 'go', 'go.mod', 'example.dev/heron/codec', '1.4.0', '1.4.3'),
        toolStep(2, 'go', 'go.mod', 'example.dev/wren/net', '0.3.1', '0.3.2'),
        // The proxy has no 0.8.4, so go get fails for this one alone.
        toolStep(3, 'go', 'go.mod', 'example.dev/tern/time', '0.8.1', '0.8.4'),
      ]
      const times = {
        'example.dev/heron/codec@1.4.3': OLD,
        'example.dev/wren/net@0.3.2': OLD,
        'example.dev/tern/time@0.8.4': OLD,
      }
      const { result } = await runApply(
        inputs(dispatch(steps, { checks: 'install' })),
        runnerDeps(root, env, times, 'go'),
      )
      expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
        ['applied', null],
        ['applied', null],
        ['failed', 'install_failed'],
      ])
      const versions = Object.fromEntries(
        parseGoMod(readText(root, 'go.mod')).requires.map((r) => [r.path, r.version]),
      )
      // 1.4.9 is published, but go get pins the checked target.
      expect(versions).toMatchObject({
        'example.dev/heron/codec': '1.4.3',
        'example.dev/wren/net': '0.3.2',
        'example.dev/tern/time': '0.8.1',
      })
      expect(readText(root, 'go.sum')).toContain('example.dev/wren/net v0.3.2/go.mod h1:')
      expect(result.patch?.files).toEqual(['go.mod', 'go.sum'])
      expect(result.install.status).toBe('ok')
      expect(result.packageManagerVersion).toMatch(/^go version go\d/)
    },
    120_000,
  )
})

// ---------------------------------------------------------------------------
// uv

function wheel(dir: string, name: string, version: string, requires: string[] = []) {
  const dist = `${name.replaceAll('-', '_')}-${version}`
  const info = `${dist}.dist-info`
  const files: Record<string, string> = {
    [`${info}/METADATA`]: [
      'Metadata-Version: 2.1',
      `Name: ${name}`,
      `Version: ${version}`,
      ...requires.map((r) => `Requires-Dist: ${r}`),
      '',
    ].join('\n'),
    [`${info}/WHEEL`]:
      'Wheel-Version: 1.0\nGenerator: hinomi-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
  }
  files[`${info}/RECORD`] =
    `${[...Object.keys(files), `${info}/RECORD`].map((f) => `${f},,`).join('\n')}\n`
  writeFile(join(dir, `${dist}-py3-none-any.whl`), storedZip(files))
}

/**
 * A source distribution that builds: its in-tree PEP 517 backend (no build requirements, so uv
 * needs nothing from an index to run it) writes `marker`, then a real wheel. Without
 * `--no-build` uv would build it to read its metadata and lock 0.4.2; with it uv must refuse.
 */
function sdist(dir: string, name: string, version: string, marker: string) {
  const work = tempDir('sdist')
  const dist = `${name.replaceAll('-', '_')}-${version}`
  const metadata = `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`
  writeFile(
    join(work, dist, 'pyproject.toml'),
    '[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n',
  )
  writeFile(
    join(work, dist, 'backend.py'),
    [
      'import os, zipfile',
      `MARKER = ${JSON.stringify(marker)}`,
      `DIST = ${JSON.stringify(dist)}`,
      `METADATA = ${JSON.stringify(metadata)}`,
      'def _ran():',
      "    open(MARKER, 'w').write('ran')",
      'def get_requires_for_build_wheel(config_settings=None):',
      '    _ran()',
      '    return []',
      'def prepare_metadata_for_build_wheel(directory, config_settings=None):',
      '    _ran()',
      "    info = os.path.join(directory, DIST + '.dist-info')",
      '    os.makedirs(info, exist_ok=True)',
      "    open(os.path.join(info, 'METADATA'), 'w').write(METADATA)",
      "    return DIST + '.dist-info'",
      'def build_wheel(directory, config_settings=None, metadata_directory=None):',
      '    _ran()',
      "    name = DIST + '-py3-none-any.whl'",
      "    info = DIST + '.dist-info/'",
      "    with zipfile.ZipFile(os.path.join(directory, name), 'w') as whl:",
      "        whl.writestr(info + 'METADATA', METADATA)",
      "        whl.writestr(info + 'WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
      "        whl.writestr(info + 'RECORD', '')",
      '    return name',
      '',
    ].join('\n'),
  )
  writeFile(join(work, dist, 'PKG-INFO'), metadata)
  // COPYFILE_DISABLE: no macOS `._` entries beside the one top level folder uv expects.
  const tar = spawnSync('tar', ['-czf', join(dir, `${dist}.tar.gz`), dist], {
    cwd: work,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (tar.status !== 0) throw new Error('tar failed')
}

/** An executable that leaves `marker` and then hands over to the runner's python3. */
function trapInterpreter(path: string, marker: string) {
  writeFile(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec python3 "$@"\n`)
  chmodSync(path, 0o755)
}

describe('real uv lock', () => {
  it.skipIf(!available('uv') || !available('python3'))(
    'pins the exact target, never builds a source distribution and never runs a repo interpreter',
    async () => {
      const wheels = tempDir('wheels')
      const markers = tempDir('marker')
      const built = join(markers, 'sdist-built')
      const venvRan = join(markers, 'venv-python-ran')
      const pinRan = join(markers, 'python-version-ran')
      for (const version of ['1.0.2', '1.0.4', '1.0.9']) wheel(wheels, 'plover-sig', version)
      wheel(wheels, 'heron-web', '2.3.0', ['plover-sig>=1.0'])
      wheel(wheels, 'wren-dom', '0.4.0')
      sdist(wheels, 'wren-dom', '0.4.2', built)
      const env = {
        ...baseEnv(),
        UV_CACHE_DIR: tempDir('uvcache'),
        UV_PYTHON_DOWNLOADS: 'never',
        UV_NO_PROGRESS: '1',
      }
      const root = await fixtureRepo('real-uv', (dir) => {
        const path = join(dir, 'pyproject.toml')
        const text = readFileSync(path, 'utf8')
          .replace('WHEELS', wheels)
          .replace('"heron-web>=2.3"', '"heron-web>=2.3", "wren-dom"')
        writeFileSync(path, text)
        const r = spawnSync(
          'uv',
          ['lock', '--no-build', '-P', 'plover-sig==1.0.2', '-P', 'wren-dom==0.4.0'],
          { cwd: dir, env, encoding: 'utf8' },
        )
        // Committed after the starting lock: a virtual environment whose interpreter and a
        // .python-version naming a path in the repo, both repo code if uv ever ran them.
        trapInterpreter(join(dir, '.venv', 'bin', 'python'), venvRan)
        trapInterpreter(join(dir, '.venv', 'bin', 'python3'), venvRan)
        writeFile(join(dir, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.12.0\n')
        trapInterpreter(join(dir, 'tools', 'py'), pinRan)
        writeFile(join(dir, '.python-version'), './tools/py\n')
        return r.status === 0 ? Promise.resolve() : Promise.reject(new Error(r.stderr))
      })
      const steps = [
        toolStep(1, 'uv', 'uv.lock', 'plover-sig', '1.0.2', '1.0.4'),
        // Only a source distribution exists for 0.4.2, and it would build without --no-build.
        toolStep(2, 'uv', 'uv.lock', 'wren-dom', '0.4.0', '0.4.2'),
      ]
      const times = { 'plover-sig@1.0.4': OLD, 'wren-dom@0.4.2': OLD }
      const { result } = await runApply(
        inputs(dispatch(steps, { checks: 'full' })),
        runnerDeps(root, env, times, 'uv'),
      )
      expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
        ['applied', null],
        ['failed', 'install_failed'],
      ])
      const locked = Object.fromEntries(
        uvLockPackages(readText(root, 'uv.lock')).map((p) => [p.name, p.version]),
      )
      expect(locked).toMatchObject({ 'plover-sig': '1.0.4', 'wren-dom': '0.4.0' })
      expect(result.patch?.files).toEqual(['uv.lock'])
      // Full mode: `uv lock --check --no-build` passes on the new lock.
      expect(result.install.status).toBe('ok')
      expect(existsSync(built)).toBe(false)
      expect(existsSync(venvRan)).toBe(false)
      expect(existsSync(pinRan)).toBe(false)
    },
    120_000,
  )
})

// ---------------------------------------------------------------------------
// composer

describe('real composer update', () => {
  it.skipIf(!available('composer', ['--version', '--no-plugins']))(
    'moves one package to the exact target and installs it in full mode, running no script',
    async () => {
      const dists = tempDir('dists')
      for (const [slug, version] of [
        ['http', '3.1.0'],
        ['uri', '1.2.0'],
        ['uri', '1.2.4'],
        ['uri', '1.2.6'],
      ] as const) {
        const manifest = JSON.stringify({ name: `kestrel/${slug}`, version })
        writeFile(
          join(dists, `${slug}-${version}.zip`),
          storedZip({ 'composer.json': manifest, 'src/Kestrel.php': '<?php\n' }),
        )
      }
      const env = {
        ...baseEnv(),
        COMPOSER_HOME: tempDir('composer-home'),
        COMPOSER_CACHE_DIR: tempDir('composer-cache'),
        COMPOSER_NO_INTERACTION: '1',
      }
      const root = await fixtureRepo('real-composer', (dir) => {
        const path = join(dir, 'composer.json')
        writeFileSync(path, readFileSync(path, 'utf8').replaceAll('DISTS', dists))
        const r = spawnSync(
          'composer',
          [
            'update',
            '--with',
            'kestrel/uri:1.2.0',
            '--no-install',
            '--no-scripts',
            '--no-plugins',
            '--no-audit',
          ],
          { cwd: dir, env, encoding: 'utf8' },
        )
        return r.status === 0 ? Promise.resolve() : Promise.reject(new Error(r.stderr))
      })
      const { result } = await runApply(
        inputs(
          dispatch([toolStep(1, 'composer', 'composer.lock', 'kestrel/uri', '1.2.0', '1.2.4')], {
            checks: 'full',
          }),
        ),
        runnerDeps(root, env, { 'kestrel/uri@1.2.4': OLD }, 'composer'),
      )
      expect(result.steps.map((s) => [s.status, s.reason])).toEqual([['applied', null]])
      const locked = Object.fromEntries(
        composerLockPackages(readText(root, 'composer.lock')).map((p) => [p.name, p.version]),
      )
      // 1.2.6 is in the repository, but the update pins the checked target.
      expect(locked).toEqual({ 'kestrel/http': '3.1.0', 'kestrel/uri': '1.2.4' })
      expect(result.patch?.files).toEqual(['composer.lock'])
      expect(result.packageManagerVersion).toMatch(/^Composer version \d/)
      // Full mode installs the new lock without --no-audit, which install does not take.
      expect(result.install).toMatchObject({ status: 'ok' })
      expect(readText(root, 'vendor/kestrel/uri/composer.json')).toContain('1.2.4')
      expect(existsSync(join(root, 'script-ran'))).toBe(false)
    },
    120_000,
  )
})
