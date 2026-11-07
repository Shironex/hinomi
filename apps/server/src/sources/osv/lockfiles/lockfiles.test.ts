import type { LockfileDependency } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  hasLockfileParser,
  isLockfileName,
  parseLockfile,
  UnsupportedLockfileError,
} from './index.js'

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

  it('resolves nested peer suffixes and patch hashes in a v9 workspace', () => {
    const lock = `lockfileVersion: 9.0

importers:

  .: {}

  apps/site:
    dependencies:
      kestrel-frame:
        specifier: 15.1.0
        version: 15.1.0(wren-dom@19.0.0(wren@19.0.0))(wren@19.0.0)
      wren:
        specifier: ^19.0.0
        version: 19.0.0
      plover-parse:
        specifier: 1.2.0
        version: 1.2.0(patch_hash=abc123)

snapshots:

  kestrel-frame@15.1.0(wren-dom@19.0.0(wren@19.0.0))(wren@19.0.0):
    dependencies:
      wren: 19.0.0
      wren-dom: 19.0.0(wren@19.0.0)

  wren@19.0.0: {}

  wren-dom@19.0.0(wren@19.0.0):
    dependencies:
      wren: 19.0.0

  plover-parse@1.2.0(patch_hash=abc123): {}
`
    expect(summary(parseLockfile(lock, 'pnpm-lock.yaml'))).toEqual({
      'kestrel-frame@15.1.0': 'runtime direct',
      'plover-parse@1.2.0': 'runtime direct',
      'wren@19.0.0': 'runtime direct',
      'wren-dom@19.0.0': 'runtime transitive',
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

const GEMFILE_LOCK = `GIT
  remote: https://git.example.dev/kestrel-co/plover.git
  revision: abc123
  specs:
    plover (0.3.0)
      rack (>= 2)

PATH
  remote: vendor/local
  specs:
    local-gem (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.1.3)
      rack (>= 2.2.4)
      rack-test (>= 0.6.3)
    nokogiri (1.15.4)
      mini_portile2 (~> 2.8.2)
      racc (~> 1.4)
    nokogiri (1.15.4-arm64-darwin)
      racc (~> 1.4)
    nokogiri (1.15.4-x86_64-linux)
      racc (~> 1.4)
    mini_portile2 (2.8.5)
    racc (1.7.3)
    rack (2.2.8)
    rack-test (2.1.0)
      rack (>= 1.3)

PLATFORMS
  arm64-darwin-23
  ruby
  x86_64-linux

DEPENDENCIES
  actionpack (~> 7.1)
  local-gem!
  nokogiri
  plover!

RUBY VERSION
   ruby 3.2.2p53

BUNDLED WITH
   2.5.6
`

describe('Gemfile.lock', () => {
  it('reads GEM specs, collapses platform variants and marks DEPENDENCIES as direct', () => {
    const deps = parseLockfile(GEMFILE_LOCK, 'Gemfile.lock')
    expect(summary(deps)).toEqual({
      'actionpack@7.1.3': 'unknown direct',
      'mini_portile2@2.8.5': 'unknown transitive',
      'nokogiri@1.15.4': 'unknown direct',
      'racc@1.7.3': 'unknown transitive',
      'rack@2.2.8': 'unknown transitive',
      'rack-test@2.1.0': 'unknown transitive',
    })
    expect(new Set(deps.map((d) => d.ecosystem))).toEqual(new Set(['RubyGems']))
    expect(deps.find((d) => d.name === 'rack')?.path).toEqual(['actionpack', 'rack'])
  })

  it('reads CRLF files and skips unknown sections and empty input', () => {
    const crlf = GEMFILE_LOCK.replace(/\n/g, '\r\n') + '\nMYSTERY\n  thing (1.0)\n'
    expect(parseLockfile(crlf, 'Gemfile.lock')).toHaveLength(6)
    expect(parseLockfile('', 'Gemfile.lock')).toEqual([])
  })
})

describe('Gemfile.lock with hostile names', () => {
  it('parses gems named like Object.prototype members without touching it', () => {
    const lock = `GEM
  remote: https://rubygems.org/
  specs:
    __proto__ (1.0.0)
      constructor (>= 0)
    constructor (2.0.0)
      prototype (>= 0)
    prototype (3.0.0)
      __proto__ (>= 0)

DEPENDENCIES
  __proto__
  toString
`
    const deps = parseLockfile(lock, 'Gemfile.lock')
    expect(deps.map((d) => d.name).sort()).toEqual(['__proto__', 'constructor', 'prototype'])
    expect(deps.find((d) => d.name === '__proto__')?.direct).toBe(true)
    expect(deps.find((d) => d.name === 'constructor')?.direct).toBe(false)
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(({} as Record<string, unknown>).version).toBeUndefined()
    expect(({} as Record<string, unknown>).deps).toBeUndefined()
  })
})

describe('parseLockfile', () => {
  it('rejects unknown file names', () => {
    expect(() => parseLockfile('', 'Pipfile.lock')).toThrow(UnsupportedLockfileError)
  })

  it('knows the names of formats without a parser and refuses them without misparsing', () => {
    for (const name of ['go.sum']) {
      expect(isLockfileName(name)).toBe(true)
      expect(hasLockfileParser(`apps/api/${name}`)).toBe(false)
      expect(() => parseLockfile('anything', name)).toThrow(UnsupportedLockfileError)
    }
    expect(hasLockfileParser('apps/api/Cargo.lock')).toBe(true)
    expect(hasLockfileParser('apps/api/go.mod')).toBe(true)
    expect(hasLockfileParser('apps/api/Gemfile.lock')).toBe(true)
  })
})

/** `name@version` -> the dependency path joined with ` > `. */
function paths(deps: LockfileDependency[]): Record<string, string | undefined> {
  return Object.fromEntries(deps.map((d) => [`${d.name}@${d.version}`, d.path?.join(' > ')]))
}

describe('dependency paths', () => {
  it('walks the pnpm graph from the importers, runtime chains first', () => {
    expect(paths(parseLockfile(PNPM_V9, 'pnpm-lock.yaml'))).toMatchObject({
      'kestrel-http@2.1.0': 'kestrel-http',
      // Reached from tern-test (dev) too, but the runtime chain explains the finding.
      'plover-parse@1.2.0': 'kestrel-http > plover-parse',
      'heron-native@0.9.1': '@kestrel/ui > wren-dom > heron-native',
      'gull-assert@5.0.0': 'tern-test > gull-assert',
    })
  })

  it('resolves package-lock.json entries like node does, nested copies included', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'kestrel-site',
          dependencies: { 'kestrel-http': '^2.0.0' },
          devDependencies: { 'tern-test': '^1.0.0' },
        },
        'node_modules/kestrel-http': {
          version: '2.1.0',
          dependencies: { 'plover-parse': '^1.0.0' },
        },
        'node_modules/plover-parse': { version: '1.2.0', dependencies: { 'wren-dom': '^1' } },
        'node_modules/wren-dom': { version: '1.0.0' },
        'node_modules/tern-test': {
          version: '1.4.0',
          dev: true,
          dependencies: { 'plover-parse': '^0.9.0' },
        },
        'node_modules/tern-test/node_modules/plover-parse': { version: '0.9.0', dev: true },
      },
    })
    expect(paths(parseLockfile(lock, 'package-lock.json'))).toEqual({
      'kestrel-http@2.1.0': 'kestrel-http',
      'plover-parse@1.2.0': 'kestrel-http > plover-parse',
      'wren-dom@1.0.0': 'kestrel-http > plover-parse > wren-dom',
      'tern-test@1.4.0': 'tern-test',
      'plover-parse@0.9.0': 'tern-test > plover-parse',
    })
  })

  it('cuts very deep chains to their first links and the vulnerable package', () => {
    const packages: Record<string, unknown> = {
      '': { dependencies: { p0: '1.0.0' } },
    }
    for (let i = 0; i < 20; i++) {
      packages[`node_modules/p${i}`] = {
        version: '1.0.0',
        ...(i < 19 && { dependencies: { [`p${i + 1}`]: '1.0.0' } }),
      }
    }
    const deep = parseLockfile(
      JSON.stringify({ lockfileVersion: 3, packages }),
      'package-lock.json',
    ).find((d) => d.name === 'p19')
    expect(deep?.path).toHaveLength(12)
    expect(deep?.path?.slice(-2)).toEqual(['...', 'p19'])
  })

  it('leaves npm v1 trees without a path', () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { 'kestrel-http': { version: '2.1.0' } },
    })
    expect(parseLockfile(v1, 'package-lock.json')[0]?.path).toBeUndefined()
  })
})

describe('workspaces', () => {
  /** `name@version` -> the workspaces that list it, direct packages only. */
  const declared = (deps: LockfileDependency[]) =>
    Object.fromEntries(
      deps.filter((d) => d.workspaces).map((d) => [`${d.name}@${d.version}`, d.workspaces]),
    )

  it('names the pnpm importers that list each direct dependency', () => {
    expect(declared(parseLockfile(PNPM_V9, 'pnpm-lock.yaml'))).toEqual({
      '@kestrel/ui@0.3.0': ['apps/web'],
      'kestrel-http@2.1.0': ['.'],
      'tern-lint@3.0.0': ['apps/web'],
      'tern-test@1.4.0': ['.'],
    })
  })

  it('names the root and workspace manifests of package-lock.json', () => {
    expect(declared(parseLockfile(PACKAGE_LOCK_V3, 'package-lock.json'))).toEqual({
      'kestrel-http@2.1.0': ['.'],
      'tern-test@1.4.0': ['.'],
      'wren-dom@1.0.0': ['apps/web'],
    })
  })

  it('names the workspace entries of yarn berry and the bun workspaces', () => {
    expect(declared(parseLockfile(YARN_BERRY, 'yarn.lock'))).toEqual({
      'kestrel-http@2.1.0': ['.'],
      'tern-test@1.4.0': ['.'],
    })
    expect(declared(parseLockfile(BUN_LOCK, 'bun.lock'))).toEqual({
      '@kestrel/ui@0.3.0': ['apps/web'],
      'kestrel-http@2.1.0': ['.'],
      'tern-test@1.4.0': ['.'],
    })
  })

  it('names the workspace crates of a Cargo.lock', () => {
    expect(declared(parseLockfile(CARGO_LOCK, 'Cargo.lock'))).toEqual({
      'kestrel-io@2.1.0': ['edge-agent'],
      'plover@1.2.0': ['edge-agent'],
    })
  })
})
