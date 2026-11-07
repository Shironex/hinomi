import { describe, expect, it } from 'vitest'
import { hasLockfileParser, parseLockfile } from './index.js'

const LOCK = JSON.stringify({
  _readme: ['This file locks the dependencies of your project.'],
  packages: [
    {
      name: 'kestrel/framework',
      version: 'v10.2.0',
      require: { php: '^8.1', 'ext-json': '*', 'tern/http': '^2.0', 'wren/log': '^1.0' },
    },
    { name: 'tern/http', version: '2.3.1', require: { php: '>=8.0', 'wren/log': '^1.0' } },
    { name: 'wren/log', version: 'v1.4.0' },
    { name: 'kestrel/branch-only', version: 'dev-main' },
    { name: 'kestrel/snapshot', version: '1.x-dev' },
  ],
  'packages-dev': [
    { name: 'plover/test', version: '9.5.0', require: { 'wren/log': '^1.0', 'lib-pcre': '*' } },
    { name: 'plover/mock', version: '1.0.0', require: { 'plover/test': '^9.0' } },
  ],
})

describe('composer.lock', () => {
  it('is registered', () => {
    expect(hasLockfileParser('app/composer.lock')).toBe(true)
  })

  it('reads versions, scopes, direct flags and paths, skipping platform and branch entries', () => {
    const deps = parseLockfile(LOCK, 'composer.lock')
    const by = Object.fromEntries(deps.map((d) => [`${d.name}@${d.version}`, d]))
    expect(Object.keys(by).sort()).toEqual([
      'kestrel/framework@10.2.0',
      'plover/mock@1.0.0',
      'plover/test@9.5.0',
      'tern/http@2.3.1',
      'wren/log@1.4.0',
    ])
    expect(by['kestrel/framework@10.2.0']).toMatchObject({
      ecosystem: 'Packagist',
      scope: 'runtime',
      direct: true,
    })
    expect(by['wren/log@1.4.0']).toMatchObject({
      scope: 'runtime',
      direct: false,
      path: ['kestrel/framework', 'wren/log'],
    })
    expect(by['plover/test@9.5.0']).toMatchObject({ scope: 'dev', direct: false })
    expect(by['plover/mock@1.0.0']).toMatchObject({ scope: 'dev', direct: true })
  })

  it('returns nothing for invalid JSON or an empty lock', () => {
    expect(parseLockfile('not json', 'composer.lock')).toEqual([])
    expect(parseLockfile('{}', 'composer.lock')).toEqual([])
    expect(parseLockfile('{"packages": null, "packages-dev": [1, {}]}', 'composer.lock')).toEqual(
      [],
    )
  })

  it('keeps hostile names from touching Object.prototype', () => {
    const names = ['__proto__', 'constructor', 'prototype']
    const hostile = `{"packages": [
      {"name": "__proto__", "version": "1.0.0", "require": {"__proto__": "*", "constructor": "*", "prototype": "*"}},
      {"name": "constructor", "version": "1.0.0", "require": {"__proto__": "*"}},
      {"name": "prototype", "version": "1.0.0", "require": {"constructor": "*"}}
    ], "packages-dev": [{"name": "kestrel/dev", "version": "1.0.0", "require": {"prototype": "*"}}],
    "__proto__": {"polluted": true}}`
    const deps = parseLockfile(hostile, 'composer.lock')
    expect(deps.map((d) => d.name).sort()).toEqual([...names, 'kestrel/dev'].sort())
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })
})
