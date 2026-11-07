import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consoleLogger, getInput, writeOutputs } from './actions-io.js'
import {
  bumpSpecifier,
  overrideKeyTargets,
  updateExistingOverrides,
} from './appliers/npm-family.js'
import { npmLockVersions } from './appliers/npm.js'
import { parsePnpmPackageKey, pnpmLockVersions } from './appliers/pnpm.js'
import { bisectInstall, firstErrorLine } from './bisect.js'
import { selectChecks } from './checks-input.js'
import { MAX_DECODED_BYTES, nodeCompressor } from './compressor.js'
import { detectProject, parsePackageManagerField } from './detect.js'
import { childEnv, formatCommand, nodeExec } from './exec.js'
import { parseJsonFile, stringifyJsonFile } from './json-file.js'
import { parseNpmrc } from './npmrc.js'
import { isAllowedPatchPath } from './patch.js'
import { npmPublishTimes, registryFor } from './registry.js'
import { checkReleaseAge, effectiveGate } from './release-age.js'
import { nodeRepoFs } from './repo-fs.js'
import { compareVersions } from './semver.js'
import { FIXTURES, NOW, daysAgo, readText } from './testing.js'

describe('semver', () => {
  it('orders versions with prerelease precedence', () => {
    const sorted = ['1.10.0', '1.2.0', '1.2.0-rc.1', '1.2.0-rc.10', '1.2.0-beta', '0.9.9'].sort(
      compareVersions,
    )
    expect(sorted).toEqual(['0.9.9', '1.2.0-beta', '1.2.0-rc.1', '1.2.0-rc.10', '1.2.0', '1.10.0'])
  })
})

describe('specifiers and overrides', () => {
  it('keeps the range prefix and refuses anything that is not a plain version', () => {
    expect(bumpSpecifier('^1.2.0', '1.4.1')).toBe('^1.4.1')
    expect(bumpSpecifier('~1.2.0', '1.4.1')).toBe('~1.4.1')
    expect(bumpSpecifier('1.2.0', '1.4.1')).toBe('1.4.1')
    for (const spec of [
      'workspace:*',
      'catalog:',
      'npm:other@1.0.0',
      '>=1.0.0 <2',
      'latest',
      'git+https://example.dev/a.git',
      'file:../a',
      '*',
    ]) {
      expect(bumpSpecifier(spec, '1.4.1')).toBeNull()
    }
  })

  it('recognises override keys for a package and updates nested npm overrides', () => {
    expect(overrideKeyTargets('wren-util', 'wren-util')).toBe(true)
    expect(overrideKeyTargets('wren-util@<2.2.0', 'wren-util')).toBe(true)
    expect(overrideKeyTargets('tern-stream>wren-util', 'wren-util')).toBe(true)
    expect(overrideKeyTargets('wren-utils', 'wren-util')).toBe(false)
    expect(overrideKeyTargets('wren-util>heron-log', 'wren-util')).toBe(false)
    const overrides = { a: { 'wren-util': '2.0.0' }, 'wren-util': { '.': '2.0.0', b: '1.0.0' } }
    expect(updateExistingOverrides(overrides, 'wren-util', '2.2.0')).toBe(2)
    expect(overrides).toEqual({
      a: { 'wren-util': '2.2.0' },
      'wren-util': { '.': '2.2.0', b: '1.0.0' },
    })
  })

  it('keeps the indent, line endings and final newline of a package.json', () => {
    const text = '{\r\n\t"name": "a",\r\n\t"dependencies": {\r\n\t\t"b": "1.0.0"\r\n\t}\r\n}'
    expect(stringifyJsonFile(parseJsonFile(text))).toBe(text)
  })
})

describe('lockfile readers', () => {
  it('reads pnpm lockfile keys of v6 and v9', () => {
    expect(parsePnpmPackageKey('/plover-parse@1.2.0(heron-log@1.8.0)')).toEqual({
      name: 'plover-parse',
      version: '1.2.0',
    })
    expect(parsePnpmPackageKey('@kestrel/kit@0.3.0')).toEqual({
      name: '@kestrel/kit',
      version: '0.3.0',
    })
    expect(parsePnpmPackageKey('link:../kit')).toBeNull()
    const lock = readText(join(FIXTURES, 'pnpm-workspace'), 'pnpm-lock.yaml')
    expect(pnpmLockVersions(lock, 'wren-util')).toEqual(['2.1.0'])
    expect(pnpmLockVersions(lock, 'kite-glob')).toEqual([])
  })

  it('reads every copy of a package in package-lock.json, nested ones too', () => {
    const lock = readText(join(FIXTURES, 'npm-overrides'), 'package-lock.json')
    expect(npmLockVersions(lock, 'wren-util').sort()).toEqual(['2.0.4', '2.1.0'])
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', dependencies: { 'wren-util': { version: '2.0.1' } } },
      },
    })
    expect(npmLockVersions(v1, 'wren-util')).toEqual(['2.0.1'])
  })
})

describe('release age', () => {
  it('uses the stricter gate and lets a repo exclusion lift only the repo gate', () => {
    const gate = {
      minutes: 20_160,
      source: 'pnpm-workspace.yaml minimumReleaseAge',
      exclude: ['@kestrel/*', 'heron-log@1.8.2'],
    }
    expect(effectiveGate(7, gate, 'plover-parse', '1.4.1')).toEqual({
      minutes: 20_160,
      days: 14,
      source: gate.source,
    })
    expect(effectiveGate(7, gate, '@kestrel/kit', '1.0.0')).toEqual({
      minutes: 10_080,
      days: 7,
      source: 'hinomi',
    })
    expect(effectiveGate(7, gate, 'heron-log', '1.8.2').source).toBe('hinomi')
    expect(effectiveGate(7, gate, 'heron-log', '1.8.3').source).toBe(gate.source)
    expect(effectiveGate(7, { ...gate, minutes: 60 }, 'plover-parse', '1.4.1').source).toBe(
      'hinomi',
    )
  })

  it('reports the eligible date of a too new version', () => {
    const gate = { minutes: 10_080, days: 7, source: 'hinomi' }
    const base = { stepId: 's', packageName: 'p', version: '1.0.0', gate, now: NOW }
    expect(checkReleaseAge({ ...base, publishedAt: daysAgo(8) })).toMatchObject({
      status: 'clear',
      eligibleAt: null,
    })
    expect(checkReleaseAge({ ...base, publishedAt: daysAgo(2) })).toMatchObject({
      status: 'too_new',
      eligibleAt: '2026-11-12T10:00:00.000Z',
    })
  })

  it('reads publish times from the registry once per package and picks the registry from .npmrc', async () => {
    const urls: string[] = []
    const times = npmPublishTimes((url) => {
      urls.push(url)
      const body = { time: { '1.0.0': '2026-10-01T00:00:00.000Z' } }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    })
    const rcs = [
      parseNpmrc('@kestrel:registry=https://npm.example.dev/\nregistry=http://evil.example.dev/'),
    ]
    expect(registryFor('@kestrel/kit', rcs)).toBe('https://npm.example.dev/')
    expect(registryFor('plover-parse', rcs)).toBe('https://registry.npmjs.org/')
    expect(await times.publishedAt('@kestrel/kit', '1.0.0', 'https://npm.example.dev/')).toEqual(
      new Date('2026-10-01T00:00:00.000Z'),
    )
    expect(await times.publishedAt('@kestrel/kit', '2.0.0', 'https://npm.example.dev/')).toBeNull()
    expect(urls).toEqual(['https://npm.example.dev/@kestrel%2fkit'])
  })

  it('treats a failing registry as an unknown publish time', async () => {
    const times = npmPublishTimes(() => Promise.reject(new Error('offline')))
    expect(await times.publishedAt('a', '1.0.0', 'https://registry.npmjs.org/')).toBeNull()
  })
})

describe('detection', () => {
  it('reads the packageManager field', () => {
    expect(parsePackageManagerField('pnpm@10.34.9+sha512.abc')).toEqual({
      name: 'pnpm',
      version: '10.34.9',
    })
    expect(parsePackageManagerField('npm')).toEqual({ name: 'npm', version: null })
    expect(parsePackageManagerField(3)).toBeNull()
  })

  it('detects pnpm and npm fixtures and refuses a folder without a lockfile', async () => {
    const pnpm = await detectProject(nodeRepoFs(join(FIXTURES, 'pnpm-workspace')), '.')
    expect(pnpm).toEqual({
      ok: true,
      project: { packageManager: 'pnpm', lockfile: 'pnpm-lock.yaml', declaredVersion: '10.34.9' },
    })
    const npm = await detectProject(nodeRepoFs(join(FIXTURES, 'npm-overrides')), '.')
    expect(npm).toMatchObject({
      ok: true,
      project: { packageManager: 'npm', declaredVersion: null },
    })
    const none = await detectProject(nodeRepoFs(join(FIXTURES, 'pnpm-workspace')), 'apps/web')
    expect(none).toMatchObject({ ok: false })
  })
})

describe('bisect', () => {
  it('finds a step that only fails together with another one', async () => {
    const tried: string[][] = []
    const result = await bisectInstall(
      ['a', 'b', 'c', 'd'],
      { ok: false, output: 'npm ERR! code ERESOLVE' },
      {
        attempt(ids) {
          tried.push(ids)
          const bad = ids.includes('b') && ids.includes('d')
          return Promise.resolve({ ok: !bad, output: bad ? 'npm ERR! code ERESOLVE\nmore' : '' })
        },
      },
    )
    expect(result.kept).toEqual(['a', 'b', 'c'])
    expect([...result.failed]).toEqual([['d', 'npm ERR! code ERESOLVE']])
    expect(tried.at(-1)).toEqual(['a', 'b', 'c'])
  })

  it('picks the error line of install output', () => {
    expect(firstErrorLine('Progress\n ERR_PNPM_NO_MATCHING_VERSION  nope\n')).toBe(
      'ERR_PNPM_NO_MATCHING_VERSION  nope',
    )
    expect(firstErrorLine('one\ntwo')).toBe('one')
  })
})

describe('inputs', () => {
  it('selects the checks mode', () => {
    expect(selectChecks('auto', 'install')).toEqual({ mode: 'install', only: null })
    expect(selectChecks('', 'full')).toEqual({ mode: 'full', only: null })
    expect(selectChecks('install', 'full')).toEqual({ mode: 'install', only: null })
    expect(selectChecks('lint, test', 'install')).toEqual({ mode: 'full', only: ['lint', 'test'] })
    expect(() => selectChecks('lint;rm -rf /', 'full')).toThrow('Invalid checks input')
  })

  it('reads inputs and writes outputs with a delimiter the value cannot end', () => {
    expect(getInput({ INPUT_RUN_ID: ' r1 ' }, 'run_id')).toBe('r1')
    const file = join(mkdtempSync(join(tmpdir(), 'hinomi-out-')), 'out')
    writeOutputs(file, { a: 'line1\nline2' })
    expect(readFileSync(file, 'utf8')).toMatch(/^a<<(hinomi_[0-9a-f-]+)\nline1\nline2\n\1\n$/)
    const lines: string[] = []
    consoleLogger((l) => lines.push(l)).error('bad\n::set-output name=x::y')
    expect(lines).toEqual(['::error::bad%0A::set-output name=x::y'])
  })
})

describe('exec', () => {
  it('drops inputs and runtime tokens from child environments', () => {
    const env = childEnv(
      { PATH: '/bin', INPUT_PLAN: '{}', ACTIONS_RUNTIME_TOKEN: 't', GITHUB_TOKEN: 't', HOME: '/h' },
      { CI: 'true' },
    )
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CI: 'true' })
  })

  it('passes arguments verbatim, never through a shell', async () => {
    const exec = nodeExec({ env: process.env })
    const payload = '$(echo pwned); `id` | cat && echo $HOME'
    const result = await exec.run(
      { file: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', payload] },
      { cwd: tmpdir(), timeoutMs: 10_000 },
    )
    expect(result).toMatchObject({ code: 0, output: payload, timedOut: false })
    expect(formatCommand({ file: 'pnpm', args: ['run', 'a b'] })).toBe('pnpm run "a b"')
  })

  it('kills a command that runs past its timeout', async () => {
    const exec = nodeExec({ env: process.env })
    const result = await exec.run(
      { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      { cwd: tmpdir(), timeoutMs: 200 },
    )
    expect(result).toMatchObject({ code: null, timedOut: true })
  })
})

describe('patch allowlist', () => {
  it('allows dependency files and step edited config only', () => {
    const steps = new Set(['.npmrc'])
    for (const path of [
      'package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package-lock.json',
      '.npmrc',
    ]) {
      expect(isAllowedPatchPath(path, steps)).toBe(true)
    }
    for (const path of [
      '.github/workflows/ci.yml',
      'src/index.ts',
      'node_modules/a/package.json',
      'apps/web/.npmrc',
      '../package.json',
      'scripts/postinstall.js',
    ]) {
      expect(isAllowedPatchPath(path, steps)).toBe(false)
    }
  })
})

describe('repo fs', () => {
  it('refuses paths that leave the checkout or touch .github', () => {
    const fs = nodeRepoFs(mkdtempSync(join(tmpdir(), 'hinomi-fs-')))
    expect(() => fs.absolute('../x/package.json')).toThrow('outside the repo')
    expect(() => fs.absolute('.github/workflows/ci.yml')).toThrow('outside the repo')
  })

  // Creating symlinks needs extra rights on Windows.
  it.skipIf(process.platform === 'win32')(
    'refuses a symlink that leaves the checkout',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hinomi-fs-'))
      const outside = mkdtempSync(join(tmpdir(), 'hinomi-outside-'))
      writeFileSync(join(outside, 'package.json'), '{}')
      symlinkSync(join(outside, 'package.json'), join(root, 'package.json'))
      await expect(nodeRepoFs(root).write('package.json', '{"a":1}')).rejects.toThrow('symlink')
      expect(readFileSync(join(outside, 'package.json'), 'utf8')).toBe('{}')
    },
  )
})

describe('compressor', () => {
  it('round trips and caps what it inflates', async () => {
    const packed = await nodeCompressor.compress('{"a":1}')
    expect(await nodeCompressor.decompress(packed)).toBe('{"a":1}')
    const big = await nodeCompressor.compress(' '.repeat(MAX_DECODED_BYTES + 1))
    await expect(nodeCompressor.decompress(big)).rejects.toThrow()
  })
})
