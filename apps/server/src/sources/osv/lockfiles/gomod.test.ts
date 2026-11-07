import { describe, expect, it } from 'vitest'
import { parseLockfile } from './index.js'

const KESTREL_API = `module example.dev/kestrel-api

go 1.22.0

toolchain go1.23.4

require example.dev/kestrel-log v1.4.2

require (
	example.dev/kestrel-http v0.9.1
	example.dev/kestrel-queue v0.0.0-20240102030405-0123456789ab
	example.dev/legacy-sdk v2.3.0+incompatible
	example.dev/kestrel-util v1.0.0 // indirect
	"example.dev/quoted" v1.1.0 // indirect
	example.dev/local-only v1.0.0
	example.dev/excluded v1.2.0
	example.dev/swapped v1.0.0
)

replace example.dev/local-only => ../local-only

replace (
	example.dev/swapped => example.dev/swapped-fork v1.0.1
	example.dev/kestrel-util v1.0.0 => example.dev/kestrel-util v1.0.5
)

exclude example.dev/excluded v1.2.0

retract (
	v1.0.0 // published by mistake
	[v1.1.0, v1.2.0]
)

godebug default=go1.21
`

function byName(text: string) {
  return Object.fromEntries(
    parseLockfile(text, 'go.mod').map((d) => [
      d.name,
      `${d.version} ${d.scope} ${d.direct ? 'direct' : 'transitive'} ${d.path?.join('>') ?? '-'}`,
    ]),
  )
}

describe('go.mod parser', () => {
  it('reads both require forms, indirect marks, replace, exclude and the toolchain', () => {
    expect(byName(KESTREL_API)).toEqual({
      'example.dev/kestrel-http': '0.9.1 unknown direct example.dev/kestrel-http',
      'example.dev/kestrel-log': '1.4.2 unknown direct example.dev/kestrel-log',
      'example.dev/kestrel-queue':
        '0.0.0-20240102030405-0123456789ab unknown direct example.dev/kestrel-queue',
      'example.dev/kestrel-util': '1.0.5 unknown transitive -',
      'example.dev/legacy-sdk': '2.3.0+incompatible unknown direct example.dev/legacy-sdk',
      'example.dev/quoted': '1.1.0 unknown transitive -',
      'example.dev/swapped-fork': '1.0.1 unknown direct example.dev/swapped-fork',
      stdlib: '1.23.4 runtime direct -',
    })
  })

  it('falls back to the go line for stdlib and normalises short and rc releases', () => {
    expect(byName('module x\n\ngo 1.21\n')).toEqual({ stdlib: '1.21.0 runtime direct -' })
    expect(byName('module x\ngo 1.22.1\n')).toEqual({ stdlib: '1.22.1 runtime direct -' })
    expect(byName('module x\ngo 1.22\ntoolchain go1.24rc1\n')).toEqual({
      stdlib: '1.24.0-rc1 runtime direct -',
    })
    expect(byName('module x\ngo 1.22\ntoolchain default\n')).toEqual({
      stdlib: '1.22.0 runtime direct -',
    })
  })

  it('applies a versioned replace only to that version and tolerates junk', () => {
    const text = [
      '\uFEFFmodule x',
      'require example.dev/a v1.0.0',
      'require example.dev/b v1.0.0',
      'replace example.dev/a v2.0.0 => example.dev/a-fork v2.0.1',
      'replace example.dev/b v1.0.0 => example.dev/b-fork v1.0.9 // pinned',
      'mystery (',
      '  anything here',
      ')',
      'tool example.dev/gen',
      'require (',
      '  broken',
      ')',
    ].join('\r\n')
    expect(Object.keys(byName(text)).sort()).toEqual(['example.dev/a', 'example.dev/b-fork'])
  })

  it('keeps hostile names from touching Object.prototype', () => {
    const text = [
      'module __proto__',
      'require (',
      '  __proto__ v1.0.0',
      '  constructor v1.0.1',
      '  prototype v1.0.2 // indirect',
      '  toString v1.0.3',
      ')',
      'replace __proto__ => constructor v2.0.0',
      'replace prototype => hasOwnProperty v3.0.0',
    ].join('\n')
    const deps = parseLockfile(text, 'go.mod')
    expect(deps.map((d) => `${d.name}@${d.version}`).sort()).toEqual(
      ['constructor@2.0.0', 'constructor@1.0.1', 'hasOwnProperty@3.0.0', 'toString@1.0.3'].sort(),
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'version')).toBe(false)
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(({} as Record<string, unknown>).version).toBeUndefined()
    expect(({} as Record<string, unknown>).name).toBeUndefined()
  })

  it('returns nothing for an empty file', () => {
    expect(parseLockfile('', 'go.mod')).toEqual([])
  })

  it('tags every dependency with the Go ecosystem', () => {
    expect(new Set(parseLockfile(KESTREL_API, 'apps/api/go.mod').map((d) => d.ecosystem))).toEqual(
      new Set(['Go']),
    )
  })
})
