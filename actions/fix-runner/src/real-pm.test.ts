import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { npmApplier } from './appliers/npm.js'
import { pnpmApplier } from './appliers/pnpm.js'
import { nodeExec } from './exec.js'
import { installCommands, runApply } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'
import {
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

// The real pnpm and npm, run against a registry this test serves on 127.0.0.1, so the
// lockfile only installs are exercised for real without any network. Lockfile only installs
// read package documents and never download tarballs, so the documents carry made up
// integrity values. Skipped on Windows, where pnpm and npm are .cmd shims that Node will not
// start without a shell (the action itself only runs on Linux runners), and when the tool is
// not on PATH.

const INTEGRITY = `sha512-${Buffer.from('x'.repeat(64)).toString('base64')}`

// What the registry has published, changed by the tests to "publish" a fix.
const published: Record<string, string[]> = {
  'plover-parse': ['1.2.0'],
  'wren-util': ['2.1.0'],
}
const DEPENDENCIES: Record<string, Record<string, string>> = {
  'plover-parse': { 'wren-util': '^2.1.0' },
  'wren-util': {},
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
      versions.map((version) => [
        version,
        {
          name,
          version,
          dependencies: DEPENDENCIES[name],
          dist: { tarball: `${base}${name}/-/${name}-${version}.tgz`, integrity: INTEGRITY },
        },
      ]),
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
    const name = decodeURIComponent((req.url ?? '/').slice(1))
    if (published[name]) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(packument(name, registry)))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** An environment that sees only the test registry and no user or global npm config. */
function isolatedEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'hinomi-runner-home-'))
  const userconfig = join(home, '.npmrc')
  writeFileSync(userconfig, '')
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    npm_config_userconfig: userconfig,
    npm_config_registry: registry,
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_cache_dir: join(home, 'pnpm-cache'),
    npm_config_store_dir: join(home, 'pnpm-store'),
    npm_config_update_notifier: 'false',
  }
}

function available(tool: string): boolean {
  if (process.platform === 'win32') return false
  return spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0
}

const TIMES = mockPublishTimes({
  'plover-parse@1.4.1': daysAgo(30),
  'wren-util@2.2.0': daysAgo(30),
})

describe.each([
  {
    tool: 'pnpm' as const,
    applier: pnpmApplier,
    lockfile: 'pnpm-lock.yaml',
    field: 'pnpm.overrides' as const,
  },
  {
    tool: 'npm' as const,
    applier: npmApplier,
    lockfile: 'package-lock.json',
    field: 'overrides' as const,
  },
])('real $tool lockfile only install', ({ tool, applier, lockfile, field }) => {
  it.skipIf(!available(tool))(
    'bumps a direct dependency and overrides a transitive one',
    async () => {
      published['plover-parse'] = ['1.2.0']
      published['wren-util'] = ['2.1.0']
      const env = isolatedEnv()
      const exec = nodeExec({ env })
      const root = await fixtureRepo(`real-${tool}`, async (dir) => {
        const ctx = {
          fs: nodeRepoFs(dir),
          root: '.',
          lockfile,
          version: null,
          publishTimes: TIMES,
          exec,
          now: NOW,
        }
        for (const command of await installCommands(applier, ctx, { repoGate: null, steps: [] })) {
          const result = await exec.run(command, { cwd: dir, timeoutMs: 60_000 })
          if (result.code !== 0) throw new Error(result.output)
        }
      })
      expect(readText(root, lockfile)).toContain('2.1.0')

      // The fixes get published.
      published['plover-parse'] = ['1.2.0', '1.4.1']
      published['wren-util'] = ['2.1.0', '2.2.0']
      const bump = step(1, {
        packageName: 'plover-parse',
        packageManager: tool,
        lockfile,
        to: '1.4.1',
        apply: {
          type: 'manifest_bump',
          manifests: ['package.json'],
          packageName: 'plover-parse',
          version: '1.4.1',
        },
      })
      const override = step(2, {
        packageName: 'wren-util',
        packageManager: tool,
        lockfile,
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
      const { result } = await runApply(inputs(dispatch([bump, override], { checks: 'install' })), {
        fs: nodeRepoFs(root),
        exec,
        publishTimes: TIMES,
        log: silentLogger(),
        now: () => NOW,
      })
      expect(result.install).toMatchObject({ status: 'ok' })
      expect(result.steps.map((s) => s.status)).toEqual(['applied', 'applied'])
      const lock = readText(root, lockfile)
      expect(lock).toContain('1.4.1')
      expect(lock).toContain('2.2.0')
      expect(lock).not.toMatch(/plover-parse@1\.2\.0|plover-parse-1\.2\.0/)
      expect(result.patch?.files).toEqual([lockfile, 'package.json'].sort())
      expect(result.packageManagerVersion).toMatch(/^\d+\.\d+\.\d+/)
    },
    120_000,
  )
})
