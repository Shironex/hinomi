import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FixDispatchStep } from '@hinomi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cargoLockVersions } from './appliers/cargo.js'
import { nodeExec } from './exec.js'
import { runApply } from './pipeline.js'
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
} from './testing.js'

// The real cargo against a sparse registry this test serves on 127.0.0.1, put in place of
// crates.io with source replacement, so `cargo update --precise` runs for real without any
// network. `cargo update` reads the index only and never downloads a crate, so the index
// entries carry made up checksums. A directory source (vendored crates) would be simpler but
// cargo ignores --precise for it. Skipped when cargo is not on PATH (GitHub's Ubuntu runners
// ship it) and on Windows, where the action never runs.

interface Release {
  vers: string
  deps?: Array<[string, string]>
  features?: Record<string, string[]>
}

const INDEX: Record<string, Release[]> = {
  'heron-codec': ['1.2.0', '1.2.5', '2.0.1', '2.1.0'].map((vers) => ({
    vers,
    features: { std: [] },
  })),
  'ibis-net': [
    {
      vers: '0.4.1',
      deps: [
        ['heron-codec', '^1.2'],
        ['wren-sys', '^0.2'],
      ],
    },
  ],
  'wren-sys': [{ vers: '0.2.1' }, { vers: '0.2.3' }],
  'swift-log': ['0.3.0', '0.3.4'].map((vers) => ({ vers, features: { default: [] } })),
  'tern-time': [{ vers: '0.8.1' }, { vers: '0.8.4' }],
  'plover-build': [{ vers: '1.1.0' }],
}

/** Sparse index path of a crate: `3/a/abc`, `ab/cd/abcd...`. */
function indexPath(name: string): string {
  if (name.length <= 2) return `${name.length}/${name}`
  if (name.length === 3) return `3/${name[0]}/${name}`
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`
}

function indexFile(name: string, releases: Release[]): string {
  const lines = releases.map((release) =>
    JSON.stringify({
      name,
      vers: release.vers,
      deps: (release.deps ?? []).map(([dep, req]) => ({
        name: dep,
        req,
        features: [],
        optional: false,
        default_features: true,
        target: null,
        kind: 'normal',
      })),
      cksum: '0'.repeat(64),
      features: release.features ?? {},
      yanked: false,
    }),
  )
  return `${lines.join('\n')}\n`
}

let server: Server
let registry = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/config.json') {
      res.end(JSON.stringify({ dl: `${registry}dl` }))
      return
    }
    const name = Object.keys(INDEX).find((crate) => url === `/${indexPath(crate)}`)
    if (name) {
      res.end(indexFile(name, INDEX[name] ?? []))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** A cargo home that replaces crates.io with the test registry, and nothing else. */
function isolatedEnv(): Record<string, string> {
  const cargoHome = mkdtempSync(join(tmpdir(), 'hinomi-runner-cargo-home-'))
  writeFileSync(
    join(cargoHome, 'config.toml'),
    `[source.crates-io]\nreplace-with = "fixture"\n\n[source.fixture]\nregistry = "sparse+${registry}"\n`,
  )
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? homedir(),
    // rustup's toolchains stay where they are, only cargo's home is swapped.
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    CARGO_HOME: cargoHome,
    CARGO_TERM_COLOR: 'never',
  }
}

function available(): boolean {
  if (process.platform === 'win32') return false
  return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
}

function cargoStep(
  order: number,
  input: Partial<FixDispatchStep> & Pick<FixDispatchStep, 'packageName' | 'to' | 'apply'>,
) {
  return step(order, {
    ecosystem: 'crates.io',
    packageManager: 'cargo',
    lockfile: 'Cargo.lock',
    ...input,
  })
}

describe('real cargo update', () => {
  it.skipIf(!available())(
    'moves a transitive crate, bumps a workspace dependency and bisects out a precise update that breaks a pin',
    async () => {
      const root = await fixtureRepo('cargo-workspace')
      const steps = [
        cargoStep(1, {
          packageName: 'wren-sys',
          relationship: 'transitive',
          from: ['0.2.1'],
          to: '0.2.3',
          apply: {
            type: 'lockfile_update',
            tool: 'cargo',
            packageName: 'wren-sys',
            from: ['0.2.1'],
            to: '0.2.3',
          },
        }),
        cargoStep(2, {
          packageName: 'heron-codec',
          from: ['1.2.0'],
          to: '2.0.1',
          level: 'major',
          workspaces: ['kestrel-api'],
          apply: {
            type: 'manifest_bump',
            manifests: [],
            packageName: 'heron-codec',
            version: '2.0.1',
          },
        }),
        // kestrel-api pins swift-log to =0.3.0, so this one cannot resolve.
        cargoStep(3, {
          packageName: 'swift-log',
          from: ['0.3.0'],
          to: '0.3.4',
          apply: {
            type: 'lockfile_update',
            tool: 'cargo',
            packageName: 'swift-log',
            from: ['0.3.0'],
            to: '0.3.4',
          },
        }),
      ]
      const times = mockPublishTimes({
        'wren-sys@0.2.3': daysAgo(30),
        'heron-codec@2.0.1': daysAgo(30),
        'swift-log@0.3.4': daysAgo(30),
      })
      const { result } = await runApply(inputs(dispatch(steps, { checks: 'install' })), {
        fs: nodeRepoFs(root),
        exec: nodeExec({ env: isolatedEnv() }),
        publishTimes: times,
        log: silentLogger(),
        now: () => NOW,
      })

      expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
        ['applied', null],
        ['applied', null],
        ['failed', 'install_failed'],
      ])
      expect(result.steps[2]?.detail).toMatch(/swift-log/)
      expect(result.install.status).toBe('ok')
      const lock = readText(root, 'Cargo.lock')
      expect(cargoLockVersions(lock, 'wren-sys')).toEqual(['0.2.3'])
      // ibis-net still needs heron-codec 1, and 2.1.0 is published but the pin keeps 2.0.1.
      expect(cargoLockVersions(lock, 'heron-codec').sort()).toEqual(['1.2.0', '2.0.1'])
      expect(cargoLockVersions(lock, 'swift-log')).toEqual(['0.3.0'])
      expect(cargoLockVersions(lock, 'tern-time')).toEqual(['0.8.1'])
      expect(readText(root, 'Cargo.toml')).toContain('heron-codec = "2.0.1"')
      expect(result.patch?.files).toEqual(['Cargo.lock', 'Cargo.toml'])
      expect(result.packageManagerVersion).toMatch(/^cargo \d+\.\d+\.\d+/)
      // cargo update resolves only: the build script never ran and nothing was built.
      expect(existsSync(join(root, 'crates/core/build-ran'))).toBe(false)
      expect(existsSync(join(root, 'target'))).toBe(false)
    },
    120_000,
  )
})
