import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { parseFixResult, type FixDispatchStep } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { composerApplier, composerLockPackages } from './appliers/composer.js'
import { GO_ENV, parseGoMod } from './appliers/go.js'
import { requirementPins } from './appliers/pip.js'
import {
  normalizePypiName,
  runnerPython,
  sourceIsPypi,
  uvApplier,
  uvEnv,
  uvLockPackages,
} from './appliers/uv.js'
import { detectProject } from './detect.js'
import { isAllowedPatchPath } from './patch.js'
import { runApply, versionLine } from './pipeline.js'
import {
  GO_PROXY,
  PACKAGIST_API,
  PYPI_API,
  goProxyEscape,
  registryPublishTimes,
  type HttpFetch,
} from './registry.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  FIXTURES,
  argv,
  daysAgo,
  deps,
  dispatch,
  fakeExec,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  readText,
  step,
  type PmHandler,
} from './testing.js'

// The lockfile update ecosystems: Go modules (go.mod and go.sum), uv (uv.lock),
// requirements.txt pins and composer (composer.lock). Each fixture repo is the lockfile
// before; the fake tool writes the lockfile after, as the real one would, and the tests check
// the commands the runner starts never run package code. Fictional packages only.

type Tool = 'go' | 'uv' | 'pip' | 'composer'

const ECOSYSTEM: Record<Tool, string> = { go: 'Go', uv: 'PyPI', pip: 'PyPI', composer: 'Packagist' }
const LOCKFILE: Record<Tool, string> = {
  go: 'go.mod',
  uv: 'uv.lock',
  pip: 'requirements.txt',
  composer: 'composer.lock',
}

function toolStep(
  order: number,
  tool: Tool,
  packageName: string,
  from: string,
  to: string,
  extra: Partial<FixDispatchStep> = {},
): FixDispatchStep {
  const lockfile = extra.lockfile ?? LOCKFILE[tool]
  return step(order, {
    id: `lockfile_update:${ECOSYSTEM[tool]}:${packageName}:${to}:${lockfile}`,
    ecosystem: ECOSYSTEM[tool],
    packageManager: tool,
    lockfile,
    relationship: 'transitive',
    packageName,
    from: [from],
    to,
    level: 'patch',
    apply: { type: 'lockfile_update', tool, packageName, from: [from], to },
    ...extra,
  })
}

/** A tool that prints a version, and on its lockfile command writes the files `after` gives. */
function fakeTool(
  root: string,
  version: string,
  isUpdate: (args: string[]) => boolean,
  after: (lockfile: string, args: string[]) => Record<string, string>,
  fail?: (args: string[]) => string | null,
): PmHandler {
  return async ({ command }) => {
    const { args } = command
    if (args.includes('--version') || args[0] === 'version') return { output: `${version}\n` }
    if (isUpdate(args)) {
      const message = fail?.(args) ?? null
      if (message) return { code: 1, output: `${message}\n` }
      const fs = nodeRepoFs(root)
      const lockfile =
        args[0] === 'get' ? 'go.mod' : args[0] === 'lock' ? 'uv.lock' : 'composer.lock'
      for (const [file, text] of Object.entries(after((await fs.read(lockfile)) ?? '', args))) {
        await fs.write(file, text)
      }
    }
    return {}
  }
}

const OLD = daysAgo(30)

// ---------------------------------------------------------------------------
// Go

describe('Go modules', () => {
  it('reads require and replace directives in both forms', () => {
    const mod = parseGoMod(readText(join(FIXTURES, 'go-module'), 'go.mod'))
    expect(mod.requires).toEqual([
      { path: 'example.dev/heron/codec', version: '1.4.0', indirect: false },
      { path: 'example.dev/plover/sig', version: '0.9.1', indirect: false },
      { path: 'example.dev/wren/net', version: '0.3.1', indirect: true },
    ])
    expect([...mod.replaced]).toEqual(['example.dev/plover/sig'])
    expect(parseGoMod('require "example.dev/a" v1.0.0 // indirect\n').requires).toEqual([
      { path: 'example.dev/a', version: '1.0.0', indirect: true },
    ])
  })

  const goAfter = (before: string, args: string[]) => {
    let mod = before
    let sum = ''
    for (const target of args.slice(1)) {
      const [path, version] = target.split('@') as [string, string]
      mod = mod.replace(new RegExp(`${path} v[^\\s]+`), `${path} ${version}`)
      sum += `${path} ${version} h1:EEEE=\n${path} ${version}/go.mod h1:FFFF=\n`
    }
    return { 'go.mod': mod, 'go.sum': sum }
  }
  const isGet = (args: string[]) => args[0] === 'get'

  it('runs one go get for direct and indirect modules, without a toolchain switch', async () => {
    const root = await fixtureRepo('go-module')
    const exec = fakeExec(fakeTool(root, 'go version go1.25.3 linux/amd64', isGet, goAfter))
    const times = mockPublishTimes({
      'example.dev/heron/codec@1.4.3': OLD,
      'example.dev/wren/net@0.3.2': OLD,
    })
    const { result, patch } = await runApply(
      inputs(
        dispatch([
          toolStep(1, 'go', 'example.dev/heron/codec', '1.4.0', '1.4.3', {
            relationship: 'direct',
          }),
          toolStep(2, 'go', 'example.dev/wren/net', '0.3.1', '0.3.2'),
        ]),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      ['applied', null],
    ])
    expect(exec.calls.map(argv)).toEqual([
      'go version',
      'go get example.dev/heron/codec@v1.4.3 example.dev/wren/net@v0.3.2',
      'go mod download',
      'go build ./...',
      'go test ./...',
    ])
    for (const call of exec.calls) expect(call.command.env).toMatchObject(GO_ENV)
    expect(GO_ENV).toEqual({ GOTOOLCHAIN: 'local', GOWORK: 'off' })
    expect(result.patch?.files).toEqual(['go.mod', 'go.sum'])
    expect(readText(root, 'go.mod')).toContain('example.dev/heron/codec v1.4.3\n')
    expect(readText(root, 'go.mod')).toContain('example.dev/wren/net v0.3.2 // indirect\n')
    expect(patch).toContain('+example.dev/wren/net v0.3.2/go.mod h1:FFFF=')
    expect(times.requests).toEqual([
      `${GO_PROXY}example.dev/heron/codec@1.4.3`,
      `${GO_PROXY}example.dev/wren/net@0.3.2`,
    ])
    expect(result.packageManager).toBe('go')
    expect(() => parseFixResult(result)).not.toThrow()
  })

  it('leaves a replaced module to a person and skips a version inside the gate', async () => {
    const root = await fixtureRepo('go-module')
    const exec = fakeExec(fakeTool(root, 'go version go1.25.3', isGet, goAfter))
    const times = mockPublishTimes({
      'example.dev/plover/sig@0.9.4': OLD,
      'example.dev/heron/codec@1.4.3': daysAgo(2),
    })
    const { result } = await runApply(
      inputs(
        dispatch(
          [
            toolStep(1, 'go', 'example.dev/plover/sig', '0.9.1', '0.9.4'),
            toolStep(2, 'go', 'example.dev/heron/codec', '1.4.0', '1.4.3'),
          ],
          { checks: 'install' },
        ),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['skipped', 'manual_specifier'],
      ['skipped', 'too_new'],
    ])
    expect(result.steps[0]?.detail).toContain('replaces example.dev/plover/sig')
    // Nothing to apply, so go get never runs.
    expect(exec.calls.map(argv)).toEqual(['go version'])
    expect(result.patch).toBeNull()
  })

  it('reports a module go get could not move as install_failed and keeps the rest', async () => {
    const root = await fixtureRepo('go-module')
    const exec = fakeExec(
      fakeTool(root, 'go version go1.25.3', isGet, goAfter, (args) =>
        args.some((a) => a.startsWith('example.dev/wren/net'))
          ? 'go: example.dev/wren/net@v0.3.2: invalid version: unknown revision v0.3.2'
          : null,
      ),
    )
    const times = mockPublishTimes({
      'example.dev/heron/codec@1.4.3': OLD,
      'example.dev/wren/net@0.3.2': OLD,
    })
    const { result } = await runApply(
      inputs(
        dispatch(
          [
            toolStep(1, 'go', 'example.dev/heron/codec', '1.4.0', '1.4.3'),
            toolStep(2, 'go', 'example.dev/wren/net', '0.3.1', '0.3.2'),
          ],
          { checks: 'install' },
        ),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      ['failed', 'install_failed'],
    ])
    expect(readText(root, 'go.mod')).toContain('example.dev/wren/net v0.3.1 // indirect')
  })
})

// ---------------------------------------------------------------------------
// uv

describe('uv', () => {
  it('reads packages and their registries from uv.lock', () => {
    const lock = readText(join(FIXTURES, 'uv-project'), 'uv.lock')
    expect(uvLockPackages(lock)).toEqual([
      { name: 'heron-web', version: '2.3.0', registry: 'https://pypi.org/simple' },
      { name: 'kestrel-api', version: '0.1.0', registry: null },
      { name: 'plover-sig', version: '1.0.2', registry: 'https://pypi.org/simple' },
      {
        name: 'wren-dom',
        version: '0.4.0',
        registry: 'https://pypi.internal.example.dev/simple',
      },
    ])
  })

  const isLock = (args: string[]) => args[0] === 'lock' && !args.includes('--check')
  const uvAfter = (before: string, args: string[]) => {
    let lock = before
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--upgrade-package') continue
      const [name, version] = (args[i + 1] ?? '').split('==') as [string, string]
      lock = lock.replace(
        new RegExp(`(name = "${normalizePypiName(name)}"\\nversion = )"[^"]+"`),
        `$1"${version}"`,
      )
    }
    return { 'uv.lock': lock }
  }

  it('locks with --no-build and an exact upgrade, and checks the lock as its install', async () => {
    const root = await fixtureRepo('uv-project')
    const exec = fakeExec(fakeTool(root, 'uv 0.13.2', isLock, uvAfter))
    const times = mockPublishTimes({ 'plover-sig@1.0.4': OLD, 'wren-dom@0.4.2': OLD })
    const { result, patch } = await runApply(
      inputs(
        dispatch([
          // GitHub's spelling of the name; the lockfile's is normalized.
          toolStep(1, 'uv', 'Plover_Sig', '1.0.2', '1.0.4'),
          toolStep(2, 'uv', 'wren-dom', '0.4.0', '0.4.2'),
        ]),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      // From a private index: no PyPI publish time to trust, so the gate holds it back.
      ['skipped', 'too_new'],
    ])
    expect(exec.calls.map(argv)).toEqual([
      'uv --version',
      'uv lock --no-build --upgrade-package Plover_Sig==1.0.4',
      'uv lock --check --no-build',
    ])
    expect(times.requests).toEqual([`${PYPI_API}plover-sig@1.0.4`])
    for (const call of exec.calls.slice(1)) {
      const vars = call.command.env ?? {}
      expect(vars).toMatchObject({ UV_PYTHON_DOWNLOADS: 'never', UV_KEYRING_PROVIDER: 'disabled' })
      for (const key of ['UV_PYTHON', 'UV_PROJECT_ENVIRONMENT', 'UV_CACHE_DIR']) {
        expect(isAbsolute(vars[key] ?? ''), key).toBe(true)
        expect((vars[key] ?? '').startsWith(root), key).toBe(false)
      }
    }
    expect(result.patch?.files).toEqual(['uv.lock'])
    expect(patch).toContain('+version = "1.0.4"')
    expect(result.checks).toEqual([])
    expect(result.install.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// requirements.txt

describe('requirements.txt', () => {
  it('finds exact pins with extras, markers, comments and hash continuations', () => {
    const text = readText(join(FIXTURES, 'pip-requirements'), 'requirements.txt')
    expect(
      requirementPins(text).map((p) => [p.name, p.version, text.slice(p.start, p.end), p.hashed]),
    ).toEqual([
      ['heron-web', '2.3.0', '2.3.0', false],
      ['plover-sig', '1.0.2', '1.0.2', false],
      ['wren-dom', '0.4.0', '0.4.0', true],
    ])
    expect(requirementPins('kestrel===1.0.0\nheron >= 1\n')).toEqual([])
  })

  it('never joins a comment line ending in a backslash with the requirement after it', () => {
    const text = '# old pin was here \\\nplover-sig==1.0.2\n  # indented \\\nwren-dom==0.4.0\n'
    expect(requirementPins(text).map((p) => [p.name, text.slice(p.start, p.end)])).toEqual([
      ['plover-sig', '1.0.2'],
      ['wren-dom', '0.4.0'],
    ])
  })

  it('edits the pins in place and runs no tool at all', async () => {
    const root = await fixtureRepo('pip-requirements')
    const exec = fakeExec(() => ({ output: 'Python 3.12.3\n' }))
    const times = mockPublishTimes({
      'heron-web@2.3.1': OLD,
      'plover-sig@1.0.4': OLD,
      'wren-dom@0.4.2': OLD,
    })
    const { result, patch } = await runApply(
      inputs(
        dispatch([
          toolStep(1, 'pip', 'heron-web', '2.3.0', '2.3.1', { relationship: 'direct' }),
          toolStep(2, 'pip', 'plover-sig', '1.0.2', '1.0.4', { relationship: 'direct' }),
          toolStep(3, 'pip', 'wren-dom', '0.4.0', '0.4.2', { relationship: 'direct' }),
        ]),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason, s.files])).toEqual([
      ['applied', null, ['requirements.txt']],
      ['applied', null, ['requirements.txt']],
      ['skipped', 'manual_specifier', []],
    ])
    expect(result.steps[2]?.detail).toContain('--hash')
    expect(readText(root, 'requirements.txt')).toBe(
      [
        '# Pinned by hand for the kestrel tools.',
        'Heron_Web[async]==2.3.1 ; python_version >= "3.12"  # web client',
        '# pinned below, see the notes \\',
        'plover-sig==1.0.4',
        'wren-dom==0.4.0 \\',
        '    --hash=sha256:2222222222222222222222222222222222222222222222222222222222222222',
        'tern-time>=0.8',
        '-r extra.txt',
        '',
      ].join('\n'),
    )
    // Only the version probe ran: no install, no lock tool, no checks.
    expect(exec.calls.map(argv)).toEqual(['python3 --version'])
    // The edit is the whole lockfile update, and there is no install to run after it.
    expect(result.install.status).toBe('ok')
    expect(result.checks).toEqual([])
    expect(result.patch?.files).toEqual(['requirements.txt'])
    expect(patch).toContain('+plover-sig==1.0.4')
    expect(times.requests).toContain(`${PYPI_API}heron-web@2.3.1`)
  })

  it.each([
    [
      'an --index-url other than PyPI',
      { 'requirements.txt': '--index-url https://pypi.internal.example.dev/simple\n' },
    ],
    ['a short -i option', { 'requirements.txt': '-ihttps://pypi.internal.example.dev/simple\n' }],
    [
      'an --extra-index-url in an included file',
      { 'extra.txt': '--extra-index-url=https://mirror.example.dev/simple\n' },
    ],
    ['--find-links in a constraints file', { 'constraints.txt': '--find-links ./wheels\n' }],
    ['--no-index', { 'requirements.txt': '--no-index\n' }],
    [
      'an included file outside the repo',
      { 'requirements.txt': '-r ../shared/requirements.txt\n' },
    ],
    ['an included file that is missing', { 'requirements.txt': '--requirement missing.txt\n' }],
    ['an included URL', { 'requirements.txt': '-c https://example.dev/constraints.txt\n' }],
  ])('trusts no PyPI publish time with %s', async (_label, prepend: Record<string, string>) => {
    const root = await fixtureRepo('pip-requirements', async (dir) => {
      const fs = nodeRepoFs(dir)
      for (const [file, line] of Object.entries(prepend)) {
        await fs.write(file, line + ((await fs.read(file)) ?? ''))
      }
    })
    const times = mockPublishTimes({ 'plover-sig@1.0.4': OLD })
    const { result } = await runApply(
      inputs(dispatch([toolStep(1, 'pip', 'plover-sig', '1.0.2', '1.0.4')])),
      deps(
        root,
        fakeExec(() => ({})),
        times,
      ),
    )
    expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'too_new' })
    expect(times.requests).toEqual([])
  })

  it('trusts PyPI publish times when the only index option names PyPI itself', async () => {
    const root = await fixtureRepo('pip-requirements', async (dir) => {
      const fs = nodeRepoFs(dir)
      await fs.write(
        'extra.txt',
        `-i https://pypi.org/simple\n${(await fs.read('extra.txt')) ?? ''}`,
      )
    })
    const times = mockPublishTimes({ 'plover-sig@1.0.4': OLD })
    const { result } = await runApply(
      inputs(dispatch([toolStep(1, 'pip', 'plover-sig', '1.0.2', '1.0.4')])),
      deps(
        root,
        fakeExec(() => ({})),
        times,
      ),
    )
    expect(result.steps[0]).toMatchObject({ status: 'applied' })
  })
})

describe('uv: where a package comes from now', () => {
  const isUvLock = (args: string[]) => args[0] === 'lock'

  it.each([
    [
      'a uv.toml in the project',
      { 'uv.toml': 'index-url = "https://mirror.example.dev/simple"\n' },
    ],
    ['a uv.toml above the project', { '../uv.toml': '' }],
    [
      'an index setting under [tool.uv]',
      { pyproject: '[tool.uv]\nextra-index-url = ["https://mirror.example.dev/simple"]\n' },
    ],
    ['find-links under [tool.uv]', { pyproject: '[tool.uv]\nfind-links = ["./wheels"]\n' }],
    [
      'a [[tool.uv.index]] other than PyPI',
      { pyproject: '[[tool.uv.index]]\nname = "m"\nurl = "https://mirror.example.dev/simple"\n' },
    ],
    [
      'a [tool.uv.sources] entry for the package',
      { pyproject: '[tool.uv.sources]\nplover-sig = { index = "m" }\n' },
    ],
    [
      'a [tool.uv.sources.<package>] table',
      { pyproject: '[tool.uv.sources.Plover_Sig]\ngit = "https://example.dev/plover.git"\n' },
    ],
  ])('trusts no PyPI publish time with %s', async (_label, extra: Record<string, string>) => {
    const nested = '../uv.toml' in extra
    const root = await fixtureRepo('uv-project', async (dir) => {
      const fs = nodeRepoFs(dir)
      for (const [file, text] of Object.entries(extra)) {
        if (file === 'pyproject') {
          await fs.write('pyproject.toml', `${(await fs.read('pyproject.toml')) ?? ''}\n${text}`)
        } else if (file === '../uv.toml') {
          // The project in a sub folder, the uv.toml at the repo root above it.
          mkdirSync(join(dir, 'py'))
          for (const name of ['pyproject.toml', 'uv.lock']) {
            await fs.write(`py/${name}`, (await fs.read(name)) ?? '')
          }
          await fs.write('uv.toml', text)
        } else {
          await fs.write(file, text)
        }
      }
    })
    const times = mockPublishTimes({ 'plover-sig@1.0.4': OLD })
    const step = {
      ...toolStep(1, 'uv', 'plover-sig', '1.0.2', '1.0.4'),
      lockfile: nested ? 'py/uv.lock' : 'uv.lock',
    }
    const { result } = await runApply(
      inputs(dispatch([step])),
      deps(root, fakeExec(fakeTool(root, 'uv 0.13.2', isUvLock, () => ({}))), times),
    )
    expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'too_new' })
    expect(times.requests).toEqual([])
  })

  it('still trusts PyPI with an explicit index the package is not sourced from', async () => {
    const root = await fixtureRepo('uv-project', async (dir) => {
      const fs = nodeRepoFs(dir)
      const extra =
        '[[tool.uv.index]]\nname = "m"\nurl = "https://mirror.example.dev/simple"\nexplicit = true\n'
      await fs.write('pyproject.toml', `${(await fs.read('pyproject.toml')) ?? ''}\n${extra}`)
    })
    expect(await sourceIsPypi(nodeRepoFs(root), '.', 'plover-sig')).toBe(true)
    expect(await sourceIsPypi(nodeRepoFs(root), '.', 'Plover.Sig')).toBe(true)
  })

  it('finds an interpreter on PATH outside the checkout only', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'hinomi-checkout-'))
    const inside = join(checkout, 'tools')
    mkdirSync(inside)
    writeFileSync(join(inside, 'python3'), '#!/bin/sh\n', { mode: 0o755 })
    const outside = mkdtempSync(join(tmpdir(), 'hinomi-bin-'))
    writeFileSync(join(outside, 'python3'), '#!/bin/sh\n', { mode: 0o755 })
    expect(runnerPython(checkout, [inside, 'relative/bin', outside].join(delimiter))).toBe(
      join(outside, 'python3'),
    )
    expect(runnerPython(checkout, inside)).toBeNull()
    expect(uvEnv(checkout, null).UV_PYTHON).toMatch(/no-python3-on-path$/)
  })
})

describe('composer', () => {
  it('reads composer.lock packages without the v prefix, marking Packagist ones', () => {
    const lock = readText(join(FIXTURES, 'composer-project'), 'composer.lock')
    expect(composerLockPackages(lock)).toEqual([
      { name: 'kestrel/http', version: '3.1.0', fromPackagist: true },
      { name: 'kestrel/uri', version: '1.2.0', fromPackagist: true },
      { name: 'kestrel/vault', version: '0.5.0', fromPackagist: false },
    ])
  })

  const isUpdate = (args: string[]) => args[0] === 'update'
  const composerAfter = (before: string, args: string[]) => {
    let lock = before
    for (const target of args.slice(1).filter((a) => !a.startsWith('-'))) {
      const [name, version] = target.split(':') as [string, string]
      lock = lock.replace(
        new RegExp(`("name": "${name}",\\s+"version": )"[^"]+"`),
        `$1"${version}"`,
      )
    }
    return { 'composer.lock': lock }
  }

  it('updates only the lock, with scripts and plugins off, and installs without them', async () => {
    const root = await fixtureRepo('composer-project')
    const exec = fakeExec(fakeTool(root, 'Composer version 2.11.1', isUpdate, composerAfter))
    const times = mockPublishTimes({ 'kestrel/uri@1.2.4': OLD, 'kestrel/vault@0.5.1': OLD })
    const { result, patch } = await runApply(
      inputs(
        dispatch([
          toolStep(1, 'composer', 'kestrel/uri', '1.2.0', '1.2.4'),
          toolStep(2, 'composer', 'kestrel/vault', '0.5.0', '0.5.1'),
        ]),
      ),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      // Not from Packagist: no publish time to trust.
      ['skipped', 'too_new'],
    ])
    const safe =
      '--no-scripts --no-plugins --no-interaction --no-progress --ignore-platform-req=ext-*'
    expect(exec.calls.map(argv)).toEqual([
      'composer --version --no-plugins --no-interaction',
      `composer update kestrel/uri:1.2.4 --no-install --minimal-changes --no-audit ${safe}`,
      // install has no --no-audit (composer 2.11 refuses it); it audits only when asked.
      `composer install ${safe}`,
    ])
    for (const call of exec.calls.slice(1)) {
      expect(call.command.env).toMatchObject({
        COMPOSER_NO_AUDIT: '1',
        COMPOSER_VENDOR_DIR: 'vendor',
      })
      // A cache outside the checkout, whatever composer.json's config.cache-dir says.
      const cacheDir = call.command.env?.COMPOSER_CACHE_DIR ?? ''
      expect(isAbsolute(cacheDir)).toBe(true)
      expect(relative(root, cacheDir).startsWith('..')).toBe(true)
    }
    expect(times.requests).toEqual([`${PACKAGIST_API}kestrel/uri@1.2.4`])
    expect(result.patch?.files).toEqual(['composer.lock'])
    expect(patch).toContain('+            "version": "1.2.4",')
  })

  it.each([
    ['a vcs repository', [{ type: 'vcs', url: 'https://example.dev/kestrel/uri.git' }]],
    ['Packagist turned off', { 'packagist.org': false }],
    ['a path repository', [{ type: 'path', url: '../uri' }]],
  ])(
    'trusts no Packagist publish time when composer.json lists %s',
    async (_label, repositories) => {
      const root = await fixtureRepo('composer-project', async (dir) => {
        const fs = nodeRepoFs(dir)
        const json = JSON.parse((await fs.read('composer.json')) ?? '{}') as Record<string, unknown>
        await fs.write('composer.json', JSON.stringify({ ...json, repositories }, null, 2))
      })
      const exec = fakeExec(fakeTool(root, 'Composer version 2.11.1', isUpdate, composerAfter))
      const times = mockPublishTimes({ 'kestrel/uri@1.2.4': OLD })
      const { result } = await runApply(
        inputs(dispatch([toolStep(1, 'composer', 'kestrel/uri', '1.2.0', '1.2.4')])),
        deps(root, exec, times),
      )
      // The lock entry still says Packagist, but the update would now look elsewhere first.
      expect(result.steps[0]).toMatchObject({ status: 'skipped', reason: 'too_new' })
      expect(times.requests).toEqual([])
    },
  )
})

describe('composer full mode and a committed vendor symlink', () => {
  const isUpdate = (args: string[]) => args[0] === 'update'

  it.each([
    ['vendor', 'vendor'],
    ['vendor/bin', 'vendor/bin'],
    ['a package folder under vendor', 'vendor/kestrel/uri'],
  ])('refuses to install through %s', async (_label, link) => {
    const outside = mkdtempSync(join(tmpdir(), 'hinomi-outside-'))
    const root = await fixtureRepo('composer-project', (dir) => {
      mkdirSync(dirname(join(dir, link)), { recursive: true })
      symlinkSync(outside, join(dir, link))
      return Promise.resolve()
    })
    const exec = fakeExec(
      fakeTool(root, 'Composer version 2.11.1', isUpdate, (lock) => ({
        'composer.lock': lock.replace('"1.2.0"', '"1.2.4"'),
      })),
    )
    const { result } = await runApply(
      inputs(
        dispatch([toolStep(1, 'composer', 'kestrel/uri', '1.2.0', '1.2.4')], { checks: 'full' }),
      ),
      deps(root, exec, mockPublishTimes({ 'kestrel/uri@1.2.4': OLD })),
    )
    expect(exec.calls.map((call) => call.command.args[0])).not.toContain('install')
    expect(result.install.status).toBe('failed')
    expect(result.install.output).toContain(`${link} is a symlink`)
    expect(readdirSync(outside)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Shared pieces

describe('detection and the patch allowlist for the new ecosystems', () => {
  it('lets a project share its folder with another family without ambiguity', async () => {
    const root = await fixtureRepo('composer-project', async (dir) => {
      const fs = nodeRepoFs(dir)
      await fs.write('package.json', JSON.stringify({ name: 'shop', packageManager: 'npm@11.6.0' }))
      await fs.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }))
      await fs.write('requirements.txt', 'plover-sig==1.0.2\n')
      await fs.write('uv.lock', 'version = 1\n')
    })
    const fs = nodeRepoFs(root)
    expect(await detectProject(fs, '.', 'composer')).toEqual({
      ok: true,
      project: { packageManager: 'composer', lockfile: 'composer.lock', declaredVersion: null },
    })
    expect(await detectProject(fs, '.', 'npm')).toMatchObject({
      ok: true,
      project: { packageManager: 'npm', declaredVersion: '11.6.0' },
    })
    // uv.lock beside requirements.txt is one Python project with two lockfiles: ambiguous.
    expect(await detectProject(fs, '.', 'pip')).toEqual({
      ok: false,
      problem: 'several lockfiles in .: uv, pip',
    })
    expect(await detectProject(nodeRepoFs(join(FIXTURES, 'go-module')), '.', 'go')).toMatchObject({
      ok: true,
      project: { packageManager: 'go', lockfile: 'go.mod' },
    })
  })

  it('allows the lockfiles of the new ecosystems and nothing beside them', () => {
    const none = new Set<string>()
    for (const path of [
      'go.mod',
      'svc/go.sum',
      'uv.lock',
      'tools/requirements.txt',
      'web/composer.lock',
    ]) {
      expect(isAllowedPatchPath(path, none)).toBe(true)
    }
    for (const path of [
      'composer.json',
      'pyproject.toml',
      'uv.toml',
      'go.work',
      'setup.py',
      'vendor/autoload.php',
      '.github/requirements.txt',
    ]) {
      expect(isAllowedPatchPath(path, none)).toBe(false)
    }
  })
})

describe('the tool version in the result', () => {
  it("takes composer's own line and cuts any line to what the result keeps", () => {
    const composer = [
      'Composer version 2.11.1 2026-10-30 14:17:07',
      'PHP version 8.4.3 (/usr/bin/php8.4)',
      'Run the "diagnose" command to get more detailed diagnostics output.',
    ].join('\n')
    expect(versionLine(composerApplier, composer)).toBe(
      'Composer version 2.11.1 2026-10-30 14:17:07',
    )
    expect(versionLine(uvApplier, `uv ${'9'.repeat(80)}\n`)).toHaveLength(64)
    expect(versionLine(uvApplier, '\n')).toBeNull()
  })
})

describe('publish times of the new registries', () => {
  function recording(bodies: Record<string, unknown>) {
    const urls: string[] = []
    const fetchImpl: HttpFetch = (url) => {
      urls.push(url)
      const body = bodies[url]
      return Promise.resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: () => Promise.resolve(body ?? {}),
      })
    }
    return { urls, times: registryPublishTimes(fetchImpl) }
  }

  it('reads the Go proxy, PyPI and Packagist, each once per document', async () => {
    const goUrl = `${GO_PROXY}github.com/!kestrel/!codec/@v/v1.4.3.info`
    const pypiUrl = `${PYPI_API}plover-sig/1.0.4/json`
    const packagistUrl = `${PACKAGIST_API}kestrel/uri.json`
    const { urls, times } = recording({
      [goUrl]: { Version: 'v1.4.3', Time: '2026-10-01T08:00:00Z' },
      [pypiUrl]: {
        urls: [
          { upload_time_iso_8601: '2026-10-02T09:00:00.000000Z' },
          { upload_time_iso_8601: '2026-10-02T08:30:00.000000Z' },
        ],
      },
      [packagistUrl]: {
        packages: {
          'kestrel/uri': [
            { version: 'v1.2.5', time: '2026-10-05T00:00:00+00:00' },
            { version: 'v1.2.4', time: '2026-10-03T00:00:00+00:00' },
          ],
        },
      },
    })
    expect(goProxyEscape('github.com/Kestrel/Codec')).toBe('github.com/!kestrel/!codec')
    expect(await times.publishedAt('github.com/Kestrel/Codec', '1.4.3', GO_PROXY)).toEqual(
      new Date('2026-10-01T08:00:00Z'),
    )
    expect(await times.publishedAt('plover-sig', '1.0.4', PYPI_API)).toEqual(
      new Date('2026-10-02T08:30:00Z'),
    )
    expect(await times.publishedAt('kestrel/uri', '1.2.4', PACKAGIST_API)).toEqual(
      new Date('2026-10-03T00:00:00Z'),
    )
    expect(await times.publishedAt('kestrel/uri', '1.2.9', PACKAGIST_API)).toBeNull()
    expect(await times.publishedAt('plover-sig', '9.9.9', PYPI_API)).toBeNull()
    expect(urls).toEqual([goUrl, pypiUrl, packagistUrl, `${PYPI_API}plover-sig/9.9.9/json`])
  })
})
