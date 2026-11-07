import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFixResult, type FixDispatchStep } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  bumpCargoManifest,
  bumpRequirement,
  cargoDependencies,
  cargoLockVersions,
  compatBucket,
  parseCargoDuration,
  parseCargoMetadata,
  preciseSources,
} from './appliers/cargo.js'
import { detectProject } from './detect.js'
import { isAllowedPatchPath } from './patch.js'
import { runApply } from './pipeline.js'
import {
  CRATES_IO_API,
  CRATES_IO_USER_AGENT,
  cratesPublishTimes,
  registryPublishTimes,
} from './registry.js'
import { nodeRepoFs } from './repo-fs.js'
import { scanToml } from './toml.js'
import {
  FIXTURES,
  argv,
  commitAll,
  daysAgo,
  deps,
  dispatch,
  fakeExec,
  fixtureRepo,
  inputs,
  mockPublishTimes,
  readText,
  step,
  type Call,
  type PmHandler,
} from './testing.js'

type CargoStepInput = Partial<FixDispatchStep> &
  Pick<FixDispatchStep, 'packageName' | 'to' | 'apply'>

function cargoStep(order: number, input: CargoStepInput): FixDispatchStep {
  return step(order, {
    ecosystem: 'crates.io',
    packageManager: 'cargo',
    lockfile: 'Cargo.lock',
    relationship: input.apply.type === 'lockfile_update' ? 'transitive' : 'direct',
    ...input,
  })
}

const wrenPrecise = cargoStep(1, {
  packageName: 'wren-sys',
  from: ['0.2.1'],
  to: '0.2.3',
  level: 'patch',
  apply: {
    type: 'lockfile_update',
    tool: 'cargo',
    packageName: 'wren-sys',
    from: ['0.2.1'],
    to: '0.2.3',
  },
})

const heronMajor = cargoStep(2, {
  packageName: 'heron-codec',
  from: ['1.2.0'],
  to: '2.0.1',
  level: 'major',
  workspaces: ['kestrel-api'],
  apply: { type: 'manifest_bump', manifests: [], packageName: 'heron-codec', version: '2.0.1' },
})

const swiftMajor = cargoStep(3, {
  packageName: 'swift-log',
  from: ['0.3.0'],
  to: '1.0.2',
  level: 'major',
  apply: { type: 'manifest_bump', manifests: [], packageName: 'swift-log', version: '1.0.2' },
})

const swiftPrecise = cargoStep(4, {
  packageName: 'swift-log',
  from: ['0.3.0'],
  to: '0.3.4',
  level: 'patch',
  apply: {
    type: 'lockfile_update',
    tool: 'cargo',
    packageName: 'swift-log',
    from: ['0.3.0'],
    to: '0.3.4',
  },
})

const TIMES = mockPublishTimes({
  'wren-sys@0.2.3': daysAgo(30),
  'heron-codec@2.0.1': daysAgo(30),
  'swift-log@1.0.2': daysAgo(30),
  'swift-log@0.3.4': daysAgo(30),
})

/** `cargo metadata --no-deps` of the fixture workspace as cargo prints it, warnings first. */
function metadata(root: string): string {
  const packages = [
    { name: 'kestrel-api', manifest_path: join(root, 'crates/api/Cargo.toml') },
    { name: 'kestrel-core', manifest_path: join(root, 'crates/core/Cargo.toml') },
  ]
  return `warning: unused manifest key: package.publish-lag\n${JSON.stringify({ packages, workspace_root: root, version: 1 })}\n`
}

/** A cargo that answers --version and metadata, and passes or fails each update. */
function fakeCargo(root: string, fail: (call: Call) => boolean = () => false): PmHandler {
  return async (call) => {
    const [sub] = call.command.args
    if (sub === '--version') return { output: 'cargo 1.94.1 (29ea6fb6a 2026-03-24)\n' }
    if (sub === 'metadata') return { output: metadata(root) }
    if (sub === 'update') {
      if (fail(call)) {
        return {
          code: 101,
          output: 'error: failed to select a version for the requirement `swift-log = "=0.3.0"`\n',
        }
      }
      const fs = nodeRepoFs(root)
      const at = call.command.args.indexOf('--precise')
      if (at !== -1) {
        const lock = (await fs.read('Cargo.lock')) ?? ''
        await fs.write('Cargo.lock', `${lock}# ${call.command.args.slice(1).join(' ')}\n`)
      }
    }
    return {}
  }
}

describe('cargo lockfile and manifests', () => {
  it('reads every locked version of a crate', () => {
    const lock = readText(join(FIXTURES, 'cargo-workspace'), 'Cargo.lock')
    expect(cargoLockVersions(lock, 'heron-codec')).toEqual(['1.2.0'])
    expect(cargoLockVersions(lock, 'kestrel-api')).toEqual(['0.1.0'])
    expect(cargoLockVersions(lock, 'missing')).toEqual([])
    const two = `${lock}\n[[package]]\nname = "heron-codec"\nversion = "2.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`
    expect(cargoLockVersions(two, 'heron-codec')).toEqual(['1.2.0', '2.0.1'])
  })

  it('finds dependencies in every table and form', () => {
    const text = [
      '[package]',
      'name = "kestrel-api"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'plain = "1.2"',
      "literal = '0.4.1'",
      'inline = { version = "~2.1", features = ["std", "derive"] }',
      'renamed = { package = "heron-codec", version = "1" }',
      'inherited = { workspace = true }',
      'dotted.version = "3"',
      'from-git = { git = "https://example.dev/kestrel/kit.git" }',
      '',
      '[dependencies.table-form]',
      'version = "=0.9.0" # pinned',
      '',
      "[target.'cfg(unix)'.build-dependencies]",
      'cfg-dep = "0.1"',
      '',
      '[workspace.dependencies]',
      'shared = """1.0"""',
    ].join('\n')
    const found = cargoDependencies(text).map((d) => [
      d.table,
      d.key,
      d.packageName,
      d.version ? text.slice(d.version.start, d.version.end) : null,
      d.workspace,
      d.nonRegistry,
    ])
    expect(found).toEqual([
      ['dependencies', 'plain', null, '"1.2"', false, false],
      ['dependencies', 'literal', null, "'0.4.1'", false, false],
      ['dependencies', 'inline', null, '"~2.1"', false, false],
      ['dependencies', 'renamed', 'heron-codec', '"1"', false, false],
      ['dependencies', 'inherited', null, null, true, false],
      ['dependencies', 'dotted', null, '"3"', false, false],
      ['dependencies', 'from-git', null, null, false, true],
      ['dependencies', 'table-form', null, '"=0.9.0"', false, false],
      ['target.cfg(unix).build-dependencies', 'cfg-dep', null, '"0.1"', false, false],
      ['workspace.dependencies', 'shared', null, '"""1.0"""', false, false],
    ])
  })

  it('scans multi line arrays, comments and quoted keys', () => {
    const text =
      'a = [\n  "x", # one\n  "y",\n]\n"quoted.key" = { b = { c = 1 } }\n[t]\nd = 1 # tail\n'
    expect(scanToml(text).map((e) => [e.table.join('.'), e.key.join('|')])).toEqual([
      ['', 'a'],
      ['', 'quoted.key'],
      ['t', 'd'],
    ])
    expect(() => scanToml('a = "open\n')).toThrow(/unterminated string on line 1/)
  })

  it('keeps the requirement operator and refuses anything that is not one plain comparator', () => {
    expect(bumpRequirement('1.2', '2.0.1')).toBe('2.0.1')
    expect(bumpRequirement('^1.2.0', '2.0.1')).toBe('^2.0.1')
    expect(bumpRequirement('~0.3', '0.4.0')).toBe('~0.4.0')
    expect(bumpRequirement('= 0.3.0', '1.0.2')).toBe('= 1.0.2')
    expect(bumpRequirement('>=1.0.0', '2.0.0')).toBe('>=2.0.0')
    for (const manual of ['*', '1.*', '>=1, <2', '<2', '', 'latest']) {
      expect(bumpRequirement(manual, '2.0.0')).toBeNull()
    }
  })

  it('rewrites only the version characters and leaves the rest of the file as it was', () => {
    const text = [
      '[dependencies]',
      'heron-codec = { version = \'1.2\', features = ["std"] } # codec',
      '',
      "[target.'cfg(windows)'.dependencies.heron-codec]",
      'version = "^1.2.0"',
      '',
      '[dev-dependencies]',
      'heron-codec = "2.4"',
      '',
    ].join('\r\n')
    const bump = bumpCargoManifest(text, 'heron-codec', '2.0.1', 'member')
    expect(bump).toMatchObject({ changed: 2, declared: 3, inherits: false, manual: null })
    expect(bump.text).toBe(
      text.replace("version = '1.2'", "version = '2.0.1'").replace('"^1.2.0"', '"^2.0.1"'),
    )
    expect(bumpCargoManifest(text, 'heron-codec', '2.0.1', 'workspace').declared).toBe(0)
    expect(
      bumpCargoManifest('[dependencies]\nheron-codec = "*"\n', 'heron-codec', '2.0.1', 'member')
        .manual,
    ).toBe('[dependencies] heron-codec has "*"')
  })

  it('picks the locked versions a precise update moves and the compatible bucket', () => {
    expect(compatBucket('2.0.1')).toBe('2')
    expect(compatBucket('0.4.2')).toBe('0.4')
    expect(compatBucket('0.0.3')).toBe('0.0.3')
    expect(preciseSources(['0.2.1', '0.3.0', '1.0.0'], ['0.2.1'], '0.2.3')).toEqual(['0.2.1'])
    // The lockfile moved since the scan: a compatible version still below `to` is moved too.
    expect(preciseSources(['0.2.2'], ['0.2.1'], '0.2.3')).toEqual(['0.2.2'])
    expect(preciseSources(['0.2.3'], ['0.2.1'], '0.2.3')).toEqual([])
  })

  it('reads cargo durations and the metadata JSON among warnings', () => {
    expect(parseCargoDuration('14 days')).toBe(14 * 1440)
    expect(parseCargoDuration('2 weeks')).toBe(14 * 1440)
    expect(parseCargoDuration('1 month')).toBe(30 * 1440)
    expect(parseCargoDuration('90 seconds')).toBe(2)
    expect(parseCargoDuration('0')).toBe(0)
    expect(parseCargoDuration('soon')).toBeNull()
    expect(parseCargoMetadata('warning: x\n{"packages":[]}\n')).toEqual({ packages: [] })
    expect(() => parseCargoMetadata('error: no Cargo.toml')).toThrow()
  })

  it('detects a Cargo.lock project and allows Cargo.toml and Cargo.lock in the patch', async () => {
    const detected = await detectProject(nodeRepoFs(join(FIXTURES, 'cargo-workspace')), '.')
    expect(detected).toEqual({
      ok: true,
      project: { packageManager: 'cargo', lockfile: 'Cargo.lock', declaredVersion: null },
    })
    const none = new Set<string>()
    expect(isAllowedPatchPath('crates/api/Cargo.toml', none)).toBe(true)
    expect(isAllowedPatchPath('Cargo.lock', none)).toBe(true)
    expect(isAllowedPatchPath('.cargo/config.toml', none)).toBe(false)
    expect(isAllowedPatchPath('crates/api/build.rs', none)).toBe(false)
  })
})

describe('crates.io publish times', () => {
  it('reads created_at once per version, names the project and spaces requests out', async () => {
    const requests: Array<{ url: string; at: number; agent: string | undefined }> = []
    let clock = 0
    const sleeps: number[] = []
    const fetchImpl = (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, at: clock, agent: init.headers['user-agent'] })
      const ok = !url.endsWith('/9.9.9')
      return Promise.resolve({
        ok,
        status: ok ? 200 : 404,
        json: () =>
          Promise.resolve({
            version: { num: '0.2.3', created_at: '2026-10-01T08:30:00.000000+00:00' },
          }),
      })
    }
    const times = cratesPublishTimes(fetchImpl, {
      intervalMs: 1000,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms)
        clock += ms
        return Promise.resolve()
      },
    })
    const [a, b, c, d] = await Promise.all([
      times.publishedAt('wren-sys', '0.2.3', CRATES_IO_API),
      times.publishedAt('wren-sys', '0.2.3', CRATES_IO_API),
      times.publishedAt('heron-codec', '2.0.1', CRATES_IO_API),
      times.publishedAt('heron-codec', '9.9.9', CRATES_IO_API),
    ])
    expect(a?.toISOString()).toBe('2026-10-01T08:30:00.000Z')
    expect(b).toBe(a)
    expect(c).not.toBeNull()
    expect(d).toBeNull()
    expect(requests.map((r) => [r.url, r.at])).toEqual([
      ['https://crates.io/api/v1/crates/wren-sys/0.2.3', 0],
      ['https://crates.io/api/v1/crates/heron-codec/2.0.1', 1000],
      ['https://crates.io/api/v1/crates/heron-codec/9.9.9', 2000],
    ])
    expect(sleeps).toEqual([1000, 1000])
    expect(requests.every((r) => r.agent === CRATES_IO_USER_AGENT)).toBe(true)
    expect(CRATES_IO_USER_AGENT).not.toMatch(/@/)
  })

  it('routes crates.io lookups away from the npm registry', async () => {
    const urls: string[] = []
    const fetchImpl = (url: string) => {
      urls.push(url)
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    }
    const times = registryPublishTimes(fetchImpl)
    await times.publishedAt('wren-sys', '0.2.3', CRATES_IO_API)
    await times.publishedAt('plover-parse', '1.4.1', 'https://registry.npmjs.org/')
    expect(urls).toEqual([
      'https://crates.io/api/v1/crates/wren-sys/0.2.3',
      'https://registry.npmjs.org/plover-parse',
    ])
  })
})

describe('runApply with cargo', () => {
  it('runs a precise update for a transitive fix and bumps a workspace dependency for a major', async () => {
    const root = await fixtureRepo('cargo-workspace')
    const exec = fakeExec(fakeCargo(root))
    const { result, patch } = await runApply(
      inputs(dispatch([wrenPrecise, heronMajor])),
      deps(root, exec, TIMES),
    )

    expect(result.steps.map((s) => [s.status, s.reason, s.files])).toEqual([
      ['applied', null, []],
      ['applied', null, ['Cargo.toml']],
    ])
    // The member inherits the requirement, so the workspace root's entry moves; the comment
    // above it and the member's own Cargo.toml stay as they were.
    expect(readText(root, 'Cargo.toml')).toContain(
      '# Shared by every crate that inherits it.\nheron-codec = "2.0.1"\n',
    )
    expect(readText(root, 'crates/api/Cargo.toml')).toContain(
      'heron-codec = { workspace = true, features = ["std"] }',
    )
    expect(exec.calls.map(argv)).toEqual([
      'cargo --version',
      'cargo metadata --format-version 1 --no-deps',
      'cargo update --workspace',
      'cargo update -p wren-sys@0.2.1 --precise 0.2.3',
      'cargo update -p heron-codec@2 --precise 2.0.1',
      'cargo fetch --locked',
      'cargo check --locked --all-targets',
      'cargo test --locked',
    ])
    expect(result.checks.map((c) => [c.name, c.command, c.status])).toEqual([
      ['cargo check', 'cargo check --locked --all-targets', 'passed'],
      ['cargo test', 'cargo test --locked', 'passed'],
    ])
    expect(result.patch?.files).toEqual(['Cargo.lock', 'Cargo.toml'])
    expect(patch).toContain('+heron-codec = "2.0.1"')
    expect(result.packageManager).toBe('cargo')
    expect(result.packageManagerVersion).toBe('cargo 1.94.1 (29ea6fb6a 2026-03-24)')
    expect(TIMES.requests).toContain(`${CRATES_IO_API}wren-sys@0.2.3`)
    expect(() => parseFixResult(result)).not.toThrow()
  })

  it('bumps every member that declares the crate, in target and dev tables, keeping the operator', async () => {
    const root = await fixtureRepo('cargo-workspace')
    const exec = fakeExec(fakeCargo(root))
    const { result } = await runApply(
      inputs(dispatch([swiftMajor], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(result.steps[0]).toMatchObject({
      status: 'applied',
      files: ['crates/api/Cargo.toml', 'crates/core/Cargo.toml'],
    })
    expect(readText(root, 'crates/api/Cargo.toml')).toContain(
      '[target.\'cfg(unix)\'.dependencies]\nswift-log = { version = "=1.0.2", default-features = false }\n',
    )
    expect(readText(root, 'crates/core/Cargo.toml')).toContain(
      '[dev-dependencies]\nswift-log = "1.0.2"\n',
    )
    expect(exec.calls.map(argv).slice(2)).toEqual([
      'cargo update --workspace',
      'cargo update -p swift-log@1 --precise 1.0.2',
    ])
  })

  it('holds back a version inside the gate, the stricter of the floor and .cargo/config.toml', async () => {
    const root = await fixtureRepo('cargo-workspace')
    mkdirSync(join(root, '.cargo'))
    writeFileSync(
      join(root, '.cargo/config.toml'),
      '[registry]\nglobal-min-publish-age = "45 days"\n',
    )
    const times = mockPublishTimes({
      'wren-sys@0.2.3': daysAgo(30),
      'heron-codec@2.0.1': daysAgo(3),
    })
    const exec = fakeExec(fakeCargo(root))
    const { result } = await runApply(
      inputs(dispatch([wrenPrecise, heronMajor])),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['skipped', 'too_new'],
      ['skipped', 'too_new'],
    ])
    expect(result.releaseAge.map((c) => [c.gateDays, c.gateSource, c.status])).toEqual([
      [45, '.cargo/config.toml registry.global-min-publish-age', 'too_new'],
      [45, '.cargo/config.toml registry.global-min-publish-age', 'too_new'],
    ])
    expect(result.patch).toBeNull()
    expect(exec.calls.map(argv)).toEqual(['cargo --version'])
  })

  it('bisects a failing precise update down to its step and keeps the rest', async () => {
    const root = await fixtureRepo('cargo-workspace')
    const exec = fakeExec(fakeCargo(root, (call) => call.command.args.includes('swift-log@0.3.0')))
    const { result } = await runApply(
      inputs(dispatch([wrenPrecise, swiftPrecise], { checks: 'install' })),
      deps(root, exec, TIMES),
    )
    expect(result.steps.map((s) => [s.status, s.reason])).toEqual([
      ['applied', null],
      ['failed', 'install_failed'],
    ])
    expect(result.steps[1]?.detail).toMatch(/^error: failed to select a version/)
    expect(result.install.status).toBe('ok')
    expect(readText(root, 'Cargo.lock')).toContain('# -p wren-sys@0.2.1 --precise 0.2.3\n')
    expect(readText(root, 'Cargo.lock')).not.toContain('swift-log@0.3.0 --precise')
    expect(result.patch?.files).toEqual(['Cargo.lock'])
  })

  it('skips specifiers it does not edit and fails a lockfile update with nothing to move', async () => {
    const root = await fixtureRepo('cargo-workspace')
    writeFileSync(
      join(root, 'crates/core/Cargo.toml'),
      readText(root, 'crates/core/Cargo.toml').replace(
        'swift-log = "0.3"',
        'swift-log = ">=0.3, <0.4"',
      ),
    )
    commitAll(root)
    // Only a manifest change could take wren-sys 0.2.1 to 0.3.5, a precise update cannot.
    const stale = cargoStep(5, {
      packageName: 'wren-sys',
      from: ['0.1.0'],
      to: '0.3.5',
      apply: {
        type: 'lockfile_update',
        tool: 'cargo',
        packageName: 'wren-sys',
        from: ['0.1.0'],
        to: '0.3.5',
      },
    })
    const times = mockPublishTimes({
      'swift-log@1.0.2': daysAgo(30),
      'wren-sys@0.3.5': daysAgo(30),
    })
    const exec = fakeExec(fakeCargo(root))
    const { result } = await runApply(
      inputs(dispatch([swiftMajor, stale])),
      deps(root, exec, times),
    )
    expect(result.steps.map((s) => [s.status, s.reason, s.detail])).toEqual([
      [
        'skipped',
        'manual_specifier',
        'crates/core/Cargo.toml [dev-dependencies] swift-log has ">=0.3, <0.4"',
      ],
      [
        'failed',
        'edit_failed',
        'Cargo.lock has wren-sys 0.2.1, none that cargo update --precise 0.3.5 can move',
      ],
    ])
    expect(readText(root, 'crates/api/Cargo.toml')).toContain('"=0.3.0"')
    expect(result.patch).toBeNull()
    expect(exec.calls.map(argv)).not.toContain('cargo update --workspace')
  })

  it('fails a bump that names a crate outside the workspace', async () => {
    const root = await fixtureRepo('cargo-workspace')
    const exec = fakeExec(fakeCargo(root))
    const notMember = { ...heronMajor, workspaces: ['kestrel-cli'] }
    const { result } = await runApply(inputs(dispatch([notMember])), deps(root, exec, TIMES))
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      reason: 'edit_failed',
      detail: 'not a workspace member: kestrel-cli',
    })
  })
})
