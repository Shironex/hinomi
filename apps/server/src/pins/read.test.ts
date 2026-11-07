import type { RuntimePinRecord } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { productionPin, readRuntimePins, isPinFilePath } from './read.js'

const read = (files: Record<string, string>, production?: string[]) =>
  readRuntimePins(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    production ? { productionDockerfiles: new Set(production) } : {},
  )

const brief = (pins: RuntimePinRecord[]) =>
  pins.map(
    (p) => [p.runtime, p.source, p.path, p.line, p.raw, p.kind, p.lineName, p.scope] as const,
  )

describe('version files', () => {
  it('reads .nvmrc, .node-version and .bun-version with their line', () => {
    const pins = read({
      '.nvmrc': '# the node line\nv22.11.0\n',
      'apps/web/.node-version': 'lts/jod',
      '.bun-version': '1.2.3\n',
    })
    expect(brief(pins)).toEqual([
      ['node', 'nvmrc', '.nvmrc', 2, 'v22.11.0', 'exact', '22', 'dev'],
      ['node', 'node_version', 'apps/web/.node-version', 1, 'lts/jod', 'exact', '22', 'dev'],
      ['bun', 'bun_version', '.bun-version', 1, '1.2.3', 'exact', '1', 'dev'],
    ])
  })

  it('reads .tool-versions for all three runtimes, first version only', () => {
    const pins = read({
      '.tool-versions':
        'python 3.12.1\nnodejs 22.11.0 20.1.0 # fallback\nbun 1.1.0\nrust stable\nnodejs 18.0.0\n',
    })
    expect(brief(pins)).toEqual([
      ['node', 'tool_versions', '.tool-versions', 2, '22.11.0', 'exact', '22', 'dev'],
      ['bun', 'tool_versions', '.tool-versions', 3, '1.1.0', 'exact', '1', 'dev'],
      ['rust', 'tool_versions', '.tool-versions', 4, 'stable', 'floating', null, 'dev'],
    ])
  })

  it('reads mise.toml strings, numbers, lists and tables', () => {
    const pins = read({
      'mise.toml': '[tools]\nnode = "22"\nbun = { version = "1.2" }\nrust = ["1.80", "stable"]\n',
    })
    expect(brief(pins)).toEqual([
      ['node', 'mise', 'mise.toml', 2, '22', 'exact', '22', 'dev'],
      ['bun', 'mise', 'mise.toml', 3, '1.2', 'exact', '1', 'dev'],
      ['rust', 'mise', 'mise.toml', 4, '1.80', 'exact', '1.80', 'dev'],
    ])
    const number = read({ '.mise.toml': '[tools]\nrust = 1.80\n' })
    expect(number[0]).toMatchObject({ raw: '1.80', lineName: '1.80', line: 2 })
  })
})

describe('package.json', () => {
  const manifest = `{
  "name": "kestrel-web",
  "packageManager": "bun@1.2.3+sha512.abc",
  "engines": {
    "node": ">=20 <23",
    "bun": ">=1.1"
  },
  "volta": { "node": "22.11.0", "npm": "10.0.0" },
  "devEngines": {
    "runtime": [
      { "name": "node", "version": "22" },
      { "name": "bun", "version": "^1.2" }
    ]
  }
}`

  it('reads engines, volta, devEngines and a bun packageManager with lines', () => {
    const pins = read({ 'package.json': manifest })
    expect(brief(pins)).toEqual([
      ['node', 'volta', 'package.json', 8, '22.11.0', 'exact', '22', 'dev'],
      ['bun', 'package_manager', 'package.json', 3, 'bun@1.2.3+sha512.abc', 'exact', '1', 'dev'],
      ['node', 'dev_engines', 'package.json', 11, '22', 'exact', '22', 'dev'],
      ['bun', 'dev_engines', 'package.json', 12, '^1.2', 'range', '1', 'dev'],
      ['node', 'engines', 'package.json', 5, '>=20 <23', 'range', '20', 'dev'],
      ['bun', 'engines', 'package.json', 6, '>=1.1', 'range', '1', 'dev'],
    ])
  })

  it('takes only the manager of packageManager, not a node pin', () => {
    const pins = read({ 'package.json': '{"packageManager":"pnpm@10.34.9"}' })
    expect(pins).toEqual([])
  })

  it('survives broken JSON and odd shapes', () => {
    expect(read({ 'package.json': '{ nope' })).toEqual([])
    expect(read({ 'package.json': '[1,2]' })).toEqual([])
    expect(read({ 'package.json': '{"engines":{"node":22},"volta":"x"}' })).toEqual([])
  })
})

describe('rust', () => {
  it('reads rust-toolchain.toml channels as floating and versions as exact', () => {
    const stable = read({
      'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\ncomponents = ["clippy"]\n',
    })
    expect(brief(stable)).toEqual([
      ['rust', 'rust_toolchain', 'rust-toolchain.toml', 2, 'stable', 'floating', null, 'dev'],
    ])
    expect(stable[0]).toMatchObject({ floating: true, version: 'stable' })
    const pinned = read({ 'crates/x/rust-toolchain.toml': '[toolchain]\nchannel = "1.82.0"\n' })
    expect(pinned[0]).toMatchObject({ kind: 'exact', lineName: '1.82', floating: false })
  })

  it('reads the legacy rust-toolchain file, bare or TOML', () => {
    expect(read({ 'rust-toolchain': 'nightly-2025-01-05\n' })[0]).toMatchObject({
      kind: 'floating',
      version: 'nightly',
      line: 1,
    })
    expect(read({ 'rust-toolchain': '1.74.1\n' })[0]).toMatchObject({
      kind: 'exact',
      lineName: '1.74',
    })
    expect(read({ 'rust-toolchain': '[toolchain]\nchannel = "beta"\n' })[0]).toMatchObject({
      version: 'beta',
      line: 2,
    })
  })

  it('records Cargo rust-version as a minimum, never as the running version', () => {
    const pins = read({
      'Cargo.toml': '[package]\nname = "kestrel"\nrust-version = "1.74"\n',
      'crates/lib/Cargo.toml': '[workspace.package]\nrust-version = "1.70.0"\n',
    })
    expect(brief(pins)).toEqual([
      ['rust', 'cargo_rust_version', 'Cargo.toml', 3, '1.74', 'minimum', '1.74', 'dev'],
      [
        'rust',
        'cargo_rust_version',
        'crates/lib/Cargo.toml',
        2,
        '1.70.0',
        'minimum',
        '1.70',
        'dev',
      ],
    ])
    expect(productionPin(pins, 'rust')).toBeNull()
  })

  it('ignores a workspace-inherited rust-version', () => {
    expect(read({ 'Cargo.toml': '[package]\nrust-version.workspace = true\n' })).toEqual([])
  })
})

describe('Dockerfile', () => {
  const text = `ARG NODE_VERSION=22
FROM node:20-alpine AS deps
RUN npm ci
FROM oven/bun:1.2 AS build
FROM node:\${NODE_VERSION}-alpine AS runtime
COPY --from=deps /app/node_modules ./node_modules
`

  it('reads every stage, marking the final lineage and production scope', () => {
    const pins = read({ Dockerfile: text, 'tools/Dockerfile.dev': 'FROM rust:1.82-slim\n' })
    expect(
      pins.map((p) => [p.runtime, p.line, p.raw, p.lineName, p.scope, p.stage, p.finalStage]),
    ).toEqual([
      ['node', 2, 'node:20-alpine', '20', 'dev', 0, true],
      ['bun', 4, 'oven/bun:1.2', '1', 'dev', 1, false],
      ['node', 5, 'node:22-alpine', '22', 'production', 2, true],
      ['rust', 1, 'rust:1.82-slim', '1.82', 'dev', 0, true],
    ])
  })

  it('takes the deployed Dockerfiles from the options', () => {
    const pins = read({ 'apps/api/Dockerfile': 'FROM node:22\n', Dockerfile: 'FROM node:20\n' }, [
      'apps/api/Dockerfile',
    ])
    expect(pins.map((p) => [p.path, p.scope])).toEqual([
      ['apps/api/Dockerfile', 'production'],
      ['Dockerfile', 'dev'],
    ])
  })

  it('marks stages whose node_modules the final image copies, and only those', () => {
    const pins = read({
      Dockerfile: [
        'FROM node:20 AS deps',
        'FROM deps AS build',
        'FROM node:18 AS assets',
        'FROM node:16 AS tools',
        'FROM node:22-alpine',
        'COPY --from=BUILD /app/node_modules ./node_modules',
        'COPY --from=assets /app/dist ./dist',
        'COPY --from=0 /app .',
        'COPY --from=node:24 /usr/local/lib/node_modules /x',
        '',
      ].join('\n'),
    })
    expect(pins.map((p) => [p.raw, p.scope, p.finalStage])).toEqual([
      ['node:20', 'dev', true],
      ['node:18', 'dev', false],
      ['node:16', 'dev', false],
      ['node:22-alpine', 'production', true],
    ])
  })

  it('follows FROM of an earlier stage and keeps an unresolved variable as unknown', () => {
    const pins = read({
      Dockerfile: 'FROM node:22 AS base\nFROM base AS final\nFROM node:${V}\n',
    })
    expect(pins.map((p) => [p.stage, p.finalStage, p.kind])).toEqual([
      [0, false, 'exact'],
      [2, true, 'unknown'],
    ])
  })
})

describe('workflows', () => {
  const ci = `name: ci
env:
  NODE_VERSION: 22
jobs:
  test:
    strategy:
      matrix:
        node: [18, 20.10, "22"]
        include:
          - node: 24
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.x
      - uses: dtolnay/rust-toolchain@1.82.0
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: nightly
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ inputs.version }}
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
`

  it('expands literal matrices, env variables and every setup action', () => {
    const pins = read({ '.github/workflows/ci.yml': ci, '.nvmrc': '22\n' })
    const workflow = pins.filter((p) => p.path.startsWith('.github'))
    expect(
      workflow.map((p) => [p.runtime, p.source, p.line, p.raw, p.kind, p.lineName, p.job, p.scope]),
    ).toEqual([
      ['node', 'setup_node', 8, '18', 'exact', '18', 'test', 'ci'],
      ['node', 'setup_node', 8, '20.10', 'exact', '20', 'test', 'ci'],
      ['node', 'setup_node', 8, '"22"', 'exact', '22', 'test', 'ci'],
      ['node', 'setup_node', 10, '24', 'exact', '24', 'test', 'ci'],
      ['node', 'setup_node', 3, '22', 'exact', '22', 'build', 'ci'],
      ['bun', 'setup_bun', 23, '1.2.x', 'range', '1', 'build', 'ci'],
      ['rust', 'rust_toolchain_action', 24, '1.82.0', 'exact', '1.82', 'build', 'ci'],
      ['rust', 'rust_toolchain_action', 27, 'nightly', 'floating', null, 'build', 'ci'],
      ['node', 'setup_node', 30, '${{ inputs.version }}', 'unknown', null, 'build', 'ci'],
      ['node', 'setup_node', 33, '.nvmrc', 'exact', '22', 'build', 'ci'],
    ])
  })

  it('splits a toolchain list and skips dtolnay@master without a toolchain', () => {
    const pins = read({
      '.github/workflows/rust.yaml': `jobs:
  a:
    steps:
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          toolchain: stable, 1.80.0
      - uses: dtolnay/rust-toolchain@master
`,
    })
    expect(pins.map((p) => [p.raw, p.kind])).toEqual([
      ['stable', 'floating'],
      ['1.80.0', 'exact'],
    ])
  })

  it('records an unresolved node-version-file as unknown', () => {
    const pins = read({
      '.github/workflows/a.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: package.json\n`,
    })
    expect(pins[0]).toMatchObject({ kind: 'unknown', raw: 'package.json', line: 6 })
  })

  it('survives YAML that is not a workflow', () => {
    expect(read({ '.github/workflows/x.yml': ': : :\n  - [' })).toEqual([])
    expect(read({ '.github/workflows/x.yml': 'jobs: 3' })).toEqual([])
  })
})

describe('productionPin', () => {
  it('prefers the deployed Dockerfile, then version files, then engines; CI never decides', () => {
    const pins = read({
      Dockerfile: 'FROM node:24\n',
      '.nvmrc': '22\n',
      'package.json': '{"engines":{"node":">=18"}}',
      '.github/workflows/ci.yml':
        'jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 16\n',
    })
    expect(productionPin(pins, 'node')).toMatchObject({ source: 'dockerfile', lineName: '24' })
    const noDocker = pins.filter((p) => p.source !== 'dockerfile')
    expect(productionPin(noDocker, 'node')).toMatchObject({ source: 'nvmrc' })
    expect(
      productionPin(
        noDocker.filter((p) => p.source === 'engines'),
        'node',
      ),
    ).toMatchObject({
      source: 'engines',
    })
    expect(
      productionPin(
        noDocker.filter((p) => p.scope === 'ci'),
        'node',
      ),
    ).toBeNull()
    expect(productionPin(pins, 'bun')).toBeNull()
  })

  it('ignores build stages and non deployed Dockerfiles', () => {
    const pins = read({ Dockerfile: 'FROM node:20 AS build\nFROM nginx\n' })
    expect(productionPin(pins, 'node')).toBeNull()
  })
})

describe('attacker controlled input', () => {
  it('treats prototype names as plain data', () => {
    const names = ['__proto__', 'constructor', 'prototype']
    const pins = read({
      'package.json': `{"engines":{"__proto__":"x","constructor":"y","node":"22"},"volta":{"__proto__":{"node":"1"}},"devEngines":{"runtime":{"__proto__":"a","name":"node","version":"20"}}}`,
      'mise.toml': `[tools]\n__proto__ = "1"\nconstructor = "2"\nnode = "22"\n[__proto__]\nnode = "3"\n`,
      '.tool-versions': names.map((n) => `${n} 1.0.0`).join('\n'),
      '.github/workflows/x.yml': `jobs:\n  __proto__:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.__proto__ }}\n    strategy:\n      matrix:\n        __proto__: [1]\n`,
      Dockerfile: 'FROM node:22\nARG __proto__=x\n',
    })
    expect(pins.length).toBeGreaterThan(0)
    expect(({} as Record<string, unknown>)['node']).toBeUndefined()
    expect(Object.getPrototypeOf({}) === Object.prototype).toBe(true)
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(pins.every((p) => ['node'].includes(p.runtime))).toBe(true)
  })
})

describe('isPinFilePath', () => {
  it('accepts the files the readers use', () => {
    for (const path of [
      '.nvmrc',
      'apps/web/package.json',
      'Dockerfile',
      'app/Dockerfile.prod',
      'api.Dockerfile',
      'Cargo.toml',
      '.github/workflows/ci.yml',
      'rust-toolchain',
    ]) {
      expect(isPinFilePath(path)).toBe(true)
    }
    for (const path of ['README.md', 'src/index.ts', '.github/dependabot.yml', 'Cargo.lock']) {
      expect(isPinFilePath(path)).toBe(false)
    }
  })
})
