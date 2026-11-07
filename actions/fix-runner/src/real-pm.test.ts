import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { FixDispatchStep } from '@hinomi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bunApplier } from './appliers/bun.js'
import { npmApplier } from './appliers/npm.js'
import { pnpmApplier } from './appliers/pnpm.js'
import type { Applier } from './appliers/types.js'
import { yarnApplier } from './appliers/yarn.js'
import { nodeExec } from './exec.js'
import { installCommands, runApply } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
  FIXTURES,
  daysAgo,
  dispatch,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  readText,
  silentLogger,
  step,
  NOW,
} from './testing.js'

// The real package managers, run against a registry this test serves on 127.0.0.1, so the
// lockfile only installs are exercised for real without any network. The registry serves
// real tarballs, because yarn (both lines) fetches them to check their integrity. Each tool
// is skipped when it is not installed; yarn comes from the PATH or, when Corepack is there,
// from Corepack at the version the fixture's packageManager field pins (Corepack downloads
// it once, the only network use). Skipped on Windows, where the tools are .cmd shims that
// Node will not start without a shell (the action itself only runs on Linux runners).

// What the registry has published, changed by the tests to "publish" a fix.
const published: Record<string, string[]> = {
  'plover-parse': ['1.2.0'],
  'wren-util': ['2.1.0'],
}
const DEPENDENCIES: Record<string, Record<string, string>> = {
  'plover-parse': { 'wren-util': '^2.1.0' },
  'wren-util': {},
}

/** One ustar entry: header, body and padding to the 512 byte block. */
function tarEntry(name: string, body: string): Buffer {
  const data = Buffer.from(body)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function tarball(name: string, version: string): Buffer {
  const manifest = JSON.stringify({ name, version, dependencies: DEPENDENCIES[name] })
  return gzipSync(Buffer.concat([tarEntry('package/package.json', manifest), Buffer.alloc(1024)]))
}

let server: Server
let registry = ''

function packument(name: string, base: string) {
  const versions = published[name] ?? []
  const latest = versions.at(-1) ?? '0.0.0'
  return {
    name,
    'dist-tags': { latest },
    versions: Object.fromEntries(
      versions.map((version) => {
        const tgz = tarball(name, version)
        return [
          version,
          {
            name,
            version,
            dependencies: DEPENDENCIES[name],
            dist: {
              tarball: `${base}${name}/-/${name}-${version}.tgz`,
              integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
              shasum: createHash('sha1').update(tgz).digest('hex'),
            },
          },
        ]
      }),
    ),
    time: {
      created: '2025-01-01T00:00:00.000Z',
      modified: '2025-06-01T00:00:00.000Z',
      ...Object.fromEntries(versions.map((v) => [v, '2025-06-01T00:00:00.000Z'])),
    },
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').slice(1))
    const file = /^(.+)\/-\/.+-(\d+\.\d+\.\d+)\.tgz$/.exec(path)
    if (file?.[1] && file[2] && published[file[1]]?.includes(file[2])) {
      res.setHeader('content-type', 'application/octet-stream')
      res.end(tarball(file[1], file[2]))
      return
    }
    if (published[path]) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(packument(path, registry)))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** A folder with a `yarn` that runs Corepack's yarn, put first on PATH when used. */
const corepackShim = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'hinomi-runner-corepack-'))
  writeFileSync(join(dir, 'yarn'), '#!/bin/sh\nexec corepack yarn "$@"\n')
  chmodSync(join(dir, 'yarn'), 0o755)
  return dir
})()

const COREPACK_ENV = {
  COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), '.cache', 'node', 'corepack'),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  COREPACK_NPM_REGISTRY: 'https://registry.npmjs.org',
}

/**
 * An environment that sees only the test registry and no user or global config. `pathPrefix`
 * goes first on PATH (the Corepack shim).
 */
function isolatedEnv(pathPrefix: string | null): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'hinomi-runner-home-'))
  const userconfig = join(home, '.npmrc')
  writeFileSync(userconfig, '')
  const path = process.env.PATH ?? ''
  return {
    PATH: pathPrefix ? `${pathPrefix}${delimiter}${path}` : path,
    HOME: home,
    npm_config_userconfig: userconfig,
    npm_config_registry: registry,
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_cache_dir: join(home, 'pnpm-cache'),
    npm_config_store_dir: join(home, 'pnpm-store'),
    npm_config_update_notifier: 'false',
    // yarn classic reads npm_config_registry; berry has its own settings.
    YARN_CACHE_FOLDER: join(home, 'yarn-cache'),
    YARN_GLOBAL_FOLDER: join(home, 'yarn-global'),
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_NPM_REGISTRY_SERVER: registry.replace(/\/$/, ''),
    YARN_UNSAFE_HTTP_WHITELIST: '127.0.0.1',
    BUN_CONFIG_REGISTRY: registry,
    BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache'),
    ...(pathPrefix === corepackShim ? COREPACK_ENV : {}),
  }
}

function versionOf(tool: string, cwd: string, env?: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null
  const result = spawnSync(tool, ['--version'], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  return result.status === 0 ? result.stdout.trim().split('\n').pop()?.trim() || null : null
}

interface Toolchain {
  /** Why the case is skipped, null when the tool is there. */
  skip: string | null
  /** Folder put first on PATH, null for none. */
  pathPrefix: string | null
}

/** The plain tool from PATH. */
function plainTool(tool: string): Toolchain {
  return versionOf(tool, tmpdir())
    ? { skip: null, pathPrefix: null }
    : { skip: `${tool} is not installed`, pathPrefix: null }
}

/** yarn of one line, from Corepack (at the fixture's pinned version) or from PATH. */
function yarnTool(fixture: string, major: (version: string) => boolean): Toolchain {
  const cwd = join(FIXTURES, fixture)
  const env = {
    ...process.env,
    ...COREPACK_ENV,
    PATH: `${corepackShim}${delimiter}${process.env.PATH ?? ''}`,
  }
  const viaCorepack = versionOf('corepack', tmpdir()) ? versionOf('yarn', cwd, env) : null
  if (viaCorepack && major(viaCorepack)) return { skip: null, pathPrefix: corepackShim }
  const plain = versionOf('yarn', cwd)
  if (plain && major(plain)) return { skip: null, pathPrefix: null }
  return {
    skip: `no ${fixture.replace('real-', '')} on PATH or through Corepack`,
    pathPrefix: null,
  }
}

const TIMES = mockPublishTimes({
  'plover-parse@1.4.1': daysAgo(30),
  'wren-util@2.2.0': daysAgo(30),
})

interface Case {
  name: string
  fixture: string
  applier: Applier
  lockfile: string
  field: Extract<FixDispatchStep['apply'], { type: 'override' }>['field']
  toolchain: () => Toolchain
  /** Runs before the first lockfile install (a bunfig.toml for the binary lockfile). */
  before?: (dir: string) => void
  /** Runs after it, before the fixture is committed. */
  after?: (dir: string) => void
  /** The lockfile as text, for the version assertions. */
  lockText?: (dir: string, env: Record<string, string>) => string
}

const bunList = (dir: string, env: Record<string, string>) =>
  spawnSync('bun', ['pm', 'ls', '--all'], { cwd: dir, env, encoding: 'utf8' }).stdout

const CASES: Case[] = [
  {
    name: 'pnpm',
    fixture: 'real-pnpm',
    applier: pnpmApplier,
    lockfile: 'pnpm-lock.yaml',
    field: 'pnpm.overrides',
    toolchain: () => plainTool('pnpm'),
  },
  {
    name: 'npm',
    fixture: 'real-npm',
    applier: npmApplier,
    lockfile: 'package-lock.json',
    field: 'overrides',
    toolchain: () => plainTool('npm'),
  },
  {
    name: 'yarn classic',
    fixture: 'real-yarn-classic',
    applier: yarnApplier,
    lockfile: 'yarn.lock',
    field: 'resolutions',
    toolchain: () => yarnTool('real-yarn-classic', (v) => v.startsWith('1.')),
  },
  {
    name: 'yarn berry',
    fixture: 'real-yarn-berry',
    applier: yarnApplier,
    lockfile: 'yarn.lock',
    field: 'resolutions',
    toolchain: () => yarnTool('real-yarn-berry', (v) => !v.startsWith('1.')),
    // Berry takes the folder with a yarn.lock as the project root.
    before: (dir) => writeFileSync(join(dir, 'yarn.lock'), ''),
  },
  {
    name: 'bun (bun.lock)',
    fixture: 'real-bun',
    applier: bunApplier,
    lockfile: 'bun.lock',
    field: 'overrides',
    toolchain: () => plainTool('bun'),
  },
  {
    name: 'bun (bun.lockb)',
    fixture: 'real-bun',
    applier: bunApplier,
    lockfile: 'bun.lockb',
    field: 'overrides',
    toolchain: () => plainTool('bun'),
    // Current bun writes bun.lock unless told otherwise, and keeps a bun.lockb it finds.
    before: (dir) =>
      writeFileSync(join(dir, 'bunfig.toml'), '[install]\nsaveTextLockfile = false\n'),
    after: (dir) => rmSync(join(dir, 'bunfig.toml')),
    lockText: bunList,
  },
]

describe.each(CASES)('real $name lockfile only install', (testCase) => {
  const { applier, lockfile, field } = testCase
  const toolchain = testCase.toolchain()
  const skipped = toolchain.skip ? ` (skipped: ${toolchain.skip})` : ''

  it.skipIf(toolchain.skip !== null)(
    `bumps a direct dependency and overrides a transitive one, with no script run${skipped}`,
    async () => {
      published['plover-parse'] = ['1.2.0']
      published['wren-util'] = ['2.1.0']
      const env = isolatedEnv(toolchain.pathPrefix)
      const exec = nodeExec({ env })
      const lockText = (dir: string) => testCase.lockText?.(dir, env) ?? readText(dir, lockfile)
      const root = await fixtureRepo(testCase.fixture, async (dir) => {
        testCase.before?.(dir)
        const version = await exec.run(applier.versionCommand, { cwd: dir, timeoutMs: 120_000 })
        const ctx = {
          fs: nodeRepoFs(dir),
          root: '.',
          lockfile,
          version: version.output.trim().split('\n').pop()?.trim() ?? null,
          publishTimes: TIMES,
          exec,
          now: NOW,
        }
        for (const command of await installCommands(applier, ctx, { repoGate: null, steps: [] })) {
          const result = await exec.run(command, { cwd: dir, timeoutMs: 120_000 })
          if (result.code !== 0) throw new Error(result.output)
        }
        testCase.after?.(dir)
      })
      expect(lockText(root)).toContain('2.1.0')
      // The lockfile install runs no lifecycle script, not even the project's own.
      expect(existsSync(join(root, 'SCRIPT_RAN'))).toBe(false)

      // The fixes get published.
      published['plover-parse'] = ['1.2.0', '1.4.1']
      published['wren-util'] = ['2.1.0', '2.2.0']
      const base = { packageManager: applier.packageManager, lockfile }
      const bump = step(1, {
        ...base,
        packageName: 'plover-parse',
        to: '1.4.1',
        apply: {
          type: 'manifest_bump',
          manifests: ['package.json'],
          packageName: 'plover-parse',
          version: '1.4.1',
        },
      })
      const override = step(2, {
        ...base,
        packageName: 'wren-util',
        from: ['2.1.0'],
        to: '2.2.0',
        apply: {
          type: 'override',
          manifest: 'package.json',
          field,
          key: 'wren-util',
          value: '2.2.0',
        },
      })
      // A fresh home and caches, as on a runner: bun keeps package documents for 5 minutes,
      // so the prepare step's cache would hide the versions just published.
      const { result } = await runApply(inputs(dispatch([bump, override], { checks: 'install' })), {
        fs: nodeRepoFs(root),
        exec: nodeExec({ env: isolatedEnv(toolchain.pathPrefix) }),
        publishTimes: TIMES,
        log: silentLogger(),
        now: () => NOW,
      })
      expect(result.install).toMatchObject({ status: 'ok' })
      expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied'])
      const lock = lockText(root)
      expect(lock).toContain('1.4.1')
      expect(lock).toContain('2.2.0')
      expect(lock).not.toMatch(/plover-parse@(npm:)?1\.2\.0|plover-parse-1\.2\.0/)
      expect(existsSync(join(root, 'SCRIPT_RAN'))).toBe(false)
      expect(result.patch?.files).toEqual([lockfile, 'package.json'].sort())
      expect(result.packageManagerVersion).toMatch(/^\d+\.\d+\.\d+/)
    },
    240_000,
  )
})
