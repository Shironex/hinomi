import type { LockfileDependency } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { parseLockfile, UnsupportedLockfileError } from './index.js'

/** `name@version` -> `scope direct|transitive`, for compact assertions. */
function summary(deps: LockfileDependency[]): Record<string, string> {
  return Object.fromEntries(
    deps.map((d) => [`${d.name}@${d.version}`, `${d.scope} ${d.direct ? 'direct' : 'transitive'}`]),
  )
}

const PNPM_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      kestrel-http:
        specifier: ^2.0.0
        version: 2.1.0
    devDependencies:
      tern-test:
        specifier: ^1.0.0
        version: 1.4.0(kestrel-http@2.1.0)

  apps/web:
    dependencies:
      '@kestrel/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      '@kestrel/ui':
        specifier: ^0.3.0
        version: 0.3.0
    devDependencies:
      tern-lint:
        specifier: ^3.0.0
        version: 3.0.0

packages:

  '@kestrel/ui@0.3.0':
    resolution: {integrity: sha512-AAAA}

  kestrel-http@2.1.0:
    resolution: {integrity: sha512-BBBB}

snapshots:

  '@kestrel/ui@0.3.0':
    dependencies:
      wren-dom: 1.0.0
      string-pad-cjs: string-pad@4.2.3

  gull-assert@5.0.0: {}

  kestrel-http@2.1.0:
    dependencies:
      plover-parse: 1.2.0

  plover-parse@1.2.0: {}

  string-pad@4.2.3: {}

  tern-lint@3.0.0:
    dependencies:
      gull-assert: 5.0.0

  tern-test@1.4.0(kestrel-http@2.1.0):
    dependencies:
      gull-assert: 5.0.0
      kestrel-http: 2.1.0
      plover-parse: 1.2.0

  wren-dom@1.0.0:
    optionalDependencies:
      heron-native: 0.9.1

  heron-native@0.9.1: {}
`

const PNPM_V6 = `lockfileVersion: '6.0'

dependencies:
  kestrel-http:
    specifier: ^2.0.0
    version: 2.1.0

devDependencies:
  tern-test:
    specifier: ^1.0.0
    version: 1.4.0(kestrel-http@2.1.0)

packages:

  /gull-assert@5.0.0:
    resolution: {integrity: sha512-CCCC}
    dev: true

  /kestrel-http@2.1.0:
    resolution: {integrity: sha512-BBBB}
    dependencies:
      plover-parse: 1.2.0
    dev: false

  /plover-parse@1.2.0:
    resolution: {integrity: sha512-DDDD}

  /tern-test@1.4.0(kestrel-http@2.1.0):
    resolution: {integrity: sha512-EEEE}
    dependencies:
      gull-assert: 5.0.0
      kestrel-http: 2.1.0
    dev: true
`

describe('pnpm-lock.yaml', () => {
  it('reads v9 importers and walks snapshots for transitive scope', () => {
    expect(summary(parseLockfile(PNPM_V9, 'pnpm-lock.yaml'))).toEqual({
      '@kestrel/ui@0.3.0': 'runtime direct',
      'gull-assert@5.0.0': 'dev transitive',
      'heron-native@0.9.1': 'runtime transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      // Reached by both a dev and a prod dependency: runtime wins.
      'plover-parse@1.2.0': 'runtime transitive',
      'string-pad@4.2.3': 'runtime transitive',
      'tern-lint@3.0.0': 'dev direct',
      'tern-test@1.4.0': 'dev direct',
      'wren-dom@1.0.0': 'runtime transitive',
    })
  })

  it('reads single project v6 files with slash prefixed keys', () => {
    expect(summary(parseLockfile(PNPM_V6, 'apps/api/pnpm-lock.yaml'))).toEqual({
      'gull-assert@5.0.0': 'dev transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      'plover-parse@1.2.0': 'runtime transitive',
      'tern-test@1.4.0': 'dev direct',
    })
  })

  it('tags every dependency with the npm ecosystem', () => {
    expect(new Set(parseLockfile(PNPM_V6, 'pnpm-lock.yaml').map((d) => d.ecosystem))).toEqual(
      new Set(['npm']),
    )
  })
})

const PACKAGE_LOCK_V3 = JSON.stringify({
  name: 'kestrel-site',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'kestrel-site',
      workspaces: ['apps/web'],
      dependencies: { 'kestrel-http': '^2.0.0' },
      devDependencies: { 'tern-test': '^1.0.0' },
    },
    'apps/web': { name: 'web', dependencies: { 'wren-dom': '^1.0.0' } },
    'node_modules/web': { resolved: 'apps/web', link: true },
    'node_modules/kestrel-http': { version: '2.1.0' },
    'node_modules/plover-parse': { version: '1.2.0' },
    'node_modules/tern-test': { version: '1.4.0', dev: true },
    'node_modules/tern-test/node_modules/plover-parse': { version: '0.9.0', dev: true },
    'node_modules/heron-native': { version: '0.9.1', devOptional: true, optional: true },
    'node_modules/wren-dom': { version: '1.0.0' },
    'node_modules/string-pad-cjs': { name: 'string-pad', version: '4.2.3' },
    'node_modules/git-thing': { version: 'git+ssh://git@example.dev/kestrel-co/thing.git#abc' },
  },
})

describe('package-lock.json', () => {
  it('uses the dev and devOptional flags and the root and workspace manifests', () => {
    expect(summary(parseLockfile(PACKAGE_LOCK_V3, 'package-lock.json'))).toEqual({
      'heron-native@0.9.1': 'dev transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      'plover-parse@0.9.0': 'dev transitive',
      'plover-parse@1.2.0': 'runtime transitive',
      'string-pad@4.2.3': 'runtime transitive',
      'tern-test@1.4.0': 'dev direct',
      'wren-dom@1.0.0': 'runtime direct',
    })
  })

  it('reads the nested tree of lockfile v1', () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        'kestrel-http': { version: '2.1.0', requires: { 'plover-parse': '^1.0.0' } },
        'tern-test': {
          version: '1.4.0',
          dev: true,
          dependencies: { 'plover-parse': { version: '0.9.0', dev: true } },
        },
        'plover-parse': { version: '1.2.0' },
      },
    })
    expect(summary(parseLockfile(v1, 'npm-shrinkwrap.json'))).toEqual({
      'kestrel-http@2.1.0': 'runtime transitive',
      'plover-parse@0.9.0': 'dev transitive',
      'plover-parse@1.2.0': 'runtime transitive',
      'tern-test@1.4.0': 'dev transitive',
    })
  })
})

const YARN_V1 = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@kestrel/ui@^0.3.0":
  version "0.3.0"
  resolved "https://registry.example.dev/@kestrel/ui/-/ui-0.3.0.tgz#aaaa"
  integrity sha512-AAAA
  dependencies:
    wren-dom "^1.0.0"

gull-assert@^5.0.0:
  version "5.0.0"
  resolved "https://registry.example.dev/gull-assert/-/gull-assert-5.0.0.tgz#cccc"

kestrel-http@^2.0.0, kestrel-http@^2.1.0:
  version "2.1.0"
  resolved "https://registry.example.dev/kestrel-http/-/kestrel-http-2.1.0.tgz#bbbb"
  dependencies:
    plover-parse "^1.2.0"

plover-parse@^1.2.0:
  version "1.2.0"

"string-pad-cjs@npm:string-pad@^4.2.0":
  version "4.2.3"

tern-test@^1.0.0:
  version "1.4.0"
  dependencies:
    gull-assert "^5.0.0"
    kestrel-http "^2.1.0"

wren-dom@^1.0.0:
  version "1.0.0"
  optionalDependencies:
    string-pad-cjs "npm:string-pad@^4.2.0"
`

const YARN_PACKAGE_JSON = JSON.stringify({
  name: 'kestrel-site',
  dependencies: { 'kestrel-http': '^2.0.0', '@kestrel/ui': '^0.3.0' },
  devDependencies: { 'tern-test': '^1.0.0' },
})

describe('yarn.lock v1', () => {
  it('reports unknown scope without package.json', () => {
    expect(summary(parseLockfile(YARN_V1, 'yarn.lock'))).toEqual({
      '@kestrel/ui@0.3.0': 'unknown transitive',
      'gull-assert@5.0.0': 'unknown transitive',
      'kestrel-http@2.1.0': 'unknown transitive',
      'plover-parse@1.2.0': 'unknown transitive',
      'string-pad@4.2.3': 'unknown transitive',
      'tern-test@1.4.0': 'unknown transitive',
      'wren-dom@1.0.0': 'unknown transitive',
    })
  })

  it('walks from package.json to tell runtime from dev', () => {
    expect(
      summary(parseLockfile(YARN_V1, 'yarn.lock', { packageJson: YARN_PACKAGE_JSON })),
    ).toEqual({
      '@kestrel/ui@0.3.0': 'runtime direct',
      'gull-assert@5.0.0': 'dev transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      'plover-parse@1.2.0': 'runtime transitive',
      'string-pad@4.2.3': 'runtime transitive',
      'tern-test@1.4.0': 'dev direct',
      'wren-dom@1.0.0': 'runtime transitive',
    })
  })
})

const YARN_BERRY = `# This file is generated by running "yarn install" inside your project.

__metadata:
  version: 8
  cacheKey: 10c0

"gull-assert@npm:^5.0.0":
  version: 5.0.0
  resolution: "gull-assert@npm:5.0.0"
  checksum: 10c0/cccc
  languageName: node
  linkType: hard

"kestrel-http@npm:^2.0.0, kestrel-http@npm:^2.1.0":
  version: 2.1.0
  resolution: "kestrel-http@npm:2.1.0"
  dependencies:
    plover-parse: "npm:^1.2.0"
  languageName: node
  linkType: hard

"kestrel-site@workspace:.":
  version: 0.0.0-use.local
  resolution: "kestrel-site@workspace:."
  dependencies:
    kestrel-http: "npm:^2.0.0"
    tern-test: "npm:^1.0.0"
  languageName: unknown
  linkType: soft

"plover-parse@npm:^1.2.0":
  version: 1.2.0
  resolution: "plover-parse@npm:1.2.0"
  languageName: node
  linkType: hard

"tern-test@npm:^1.0.0":
  version: 1.4.0
  resolution: "tern-test@npm:1.4.0"
  dependencies:
    gull-assert: "npm:^5.0.0"
  languageName: node
  linkType: hard

"tide-local@file:./vendor/tide::locator=kestrel-site%40workspace%3A.":
  version: 1.0.0
  resolution: "tide-local@file:./vendor/tide#./vendor/tide::hash=abc&locator=kestrel-site%40workspace%3A."
  languageName: node
  linkType: hard
`

describe('yarn.lock berry', () => {
  it('marks workspace dependencies direct and keeps scope unknown', () => {
    expect(summary(parseLockfile(YARN_BERRY, 'yarn.lock'))).toEqual({
      'gull-assert@5.0.0': 'unknown transitive',
      'kestrel-http@2.1.0': 'unknown direct',
      'plover-parse@1.2.0': 'unknown transitive',
      'tern-test@1.4.0': 'unknown direct',
    })
  })

  it('uses package.json ranges without the npm: prefix', () => {
    const pkg = JSON.stringify({
      dependencies: { 'kestrel-http': '^2.0.0' },
      devDependencies: { 'tern-test': '^1.0.0' },
    })
    expect(summary(parseLockfile(YARN_BERRY, 'yarn.lock', { packageJson: pkg }))).toEqual({
      'gull-assert@5.0.0': 'dev transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      'plover-parse@1.2.0': 'runtime transitive',
      'tern-test@1.4.0': 'dev direct',
    })
  })
})

const BUN_LOCK = `{
  "lockfileVersion": 1,
  // workspaces hold every manifest's dependency maps
  "workspaces": {
    "": {
      "name": "kestrel-site",
      "dependencies": {
        "kestrel-http": "^2.0.0",
      },
      "devDependencies": {
        "tern-test": "^1.0.0",
      },
    },
    "apps/web": {
      "name": "web",
      "dependencies": {
        "@kestrel/ui": "^0.3.0",
        "kestrel-site": "workspace:*",
      },
    },
  },
  "packages": {
    "@kestrel/ui": ["@kestrel/ui@0.3.0", "", { "dependencies": { "plover-parse": "^0.9.0" } }, "sha512-AAAA"],
    "@kestrel/ui/plover-parse": ["plover-parse@0.9.0", "", {}, "sha512-FFFF"],
    "gull-assert": ["gull-assert@5.0.0", "", {}, "sha512-CCCC"],
    "kestrel-http": ["kestrel-http@2.1.0", "", { "dependencies": { "plover-parse": "^1.2.0" } }, "sha512-BBBB"],
    "kestrel-site": ["kestrel-site@workspace:."],
    "plover-parse": ["plover-parse@1.2.0", "", {}, "sha512-DDDD"],
    "tern-test": ["tern-test@1.4.0", "", { "dependencies": { "gull-assert": "^5.0.0" } }, "sha512-EEEE"],
  }
}
`

describe('bun.lock', () => {
  it('strips JSONC and resolves nested keys like node_modules lookup', () => {
    expect(summary(parseLockfile(BUN_LOCK, 'bun.lock'))).toEqual({
      '@kestrel/ui@0.3.0': 'runtime direct',
      'gull-assert@5.0.0': 'dev transitive',
      'kestrel-http@2.1.0': 'runtime direct',
      'plover-parse@0.9.0': 'runtime transitive',
      'plover-parse@1.2.0': 'runtime transitive',
      'tern-test@1.4.0': 'dev direct',
    })
  })
})

const CARGO_LOCK = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 4

[[package]]
name = "edge-agent"
version = "0.1.0"
dependencies = [
 "kestrel-io",
 "plover 1.2.0",
]

[[package]]
name = "kestrel-io"
version = "2.1.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaa"
dependencies = [
 "plover 0.9.0",
]

[[package]]
name = "plover"
version = "0.9.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "plover"
version = "1.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tide-git"
version = "0.3.0"
source = "git+https://example.dev/kestrel-co/tide#abcdef"
`

describe('Cargo.lock', () => {
  it('reads registry crates with unknown scope and direct deps of workspace crates', () => {
    const deps = parseLockfile(CARGO_LOCK, 'Cargo.lock')
    expect(summary(deps)).toEqual({
      'kestrel-io@2.1.0': 'unknown direct',
      'plover@0.9.0': 'unknown transitive',
      'plover@1.2.0': 'unknown direct',
    })
    expect(new Set(deps.map((d) => d.ecosystem))).toEqual(new Set(['crates.io']))
  })
})

describe('parseLockfile', () => {
  it('rejects unknown file names', () => {
    expect(() => parseLockfile('', 'Gemfile.lock')).toThrow(UnsupportedLockfileError)
  })
})
