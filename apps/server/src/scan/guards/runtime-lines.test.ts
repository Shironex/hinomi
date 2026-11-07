import type { RuntimePinRecord } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { deployedDockerfilePath, deployedDockerfiles } from '../../pins/index.js'
import { lineSatisfies, newestVersion, retarget } from './runtime-lines.js'
import { runtimeSupportIndex } from './runtime-testing.js'

describe('lineSatisfies', () => {
  it.each([
    ['>=20', '22', true],
    ['>=20 <23', '24', false],
    ['>=20 <23', '22', true],
    ['^22 || ^24', '24', true],
    ['^22 || ^24', '26', false],
    ['20.x', '20', true],
    ['20.x', '22', false],
    ['18 - 22', '22', true],
    ['18 - 22', '24', false],
    ['~22.1', '22', true],
    ['<22', '22', false],
    ['<=22', '22', true],
    ['>22', '22', false],
    ['>22.1', '22', true],
    ['>= 20', '18', false],
    ['*', '18', true],
    ['not a range', '18', true],
  ])('%s with line %s is %s', (range, line, expected) => {
    expect(lineSatisfies('node', range, line)).toBe(expected)
  })

  it('reads Rust lines as major.minor', () => {
    expect(lineSatisfies('rust', '>=1.80', '1.79')).toBe(false)
    expect(lineSatisfies('rust', '>=1.80', '1.80')).toBe(true)
  })
})

describe('retarget', () => {
  const pin = (over: Partial<RuntimePinRecord>): RuntimePinRecord => ({
    runtime: 'node',
    source: 'nvmrc',
    path: '.nvmrc',
    line: 1,
    raw: '22',
    lineName: '22',
    floating: false,
    kind: 'exact',
    version: '22',
    scope: 'dev',
    job: null,
    stage: null,
    finalStage: null,
    ...over,
  })
  const target = { line: '24', latest: '24.11.0' }

  it('keeps the precision and the rest of the text', () => {
    expect(retarget(pin({}), target)).toBe('24')
    expect(retarget(pin({ raw: 'v22.11.0', version: '22.11.0' }), target)).toBe('v24.11.0')
    expect(retarget(pin({ raw: 'node:22.11-bookworm-slim', version: '22.11' }), target)).toBe(
      'node:24.11-bookworm-slim',
    )
    expect(retarget(pin({ raw: 'node:20-alpine3.20', version: '20' }), target)).toBe(
      'node:24-alpine3.20',
    )
    expect(retarget(pin({ raw: 'lts/jod', version: '22' }), target)).toBe('24')
  })

  it('rewrites a single comparator range in place and replaces a compound one', () => {
    expect(retarget(pin({ kind: 'range', raw: '^22.1', version: '^22.1' }), target)).toBe('^24.11')
    expect(retarget(pin({ kind: 'range', raw: '>=20 <23', version: '>=20 <23' }), target)).toBe(
      '>=24',
    )
  })
})

describe('newestVersion', () => {
  it('takes the newest latest release of any line', () => {
    const index = runtimeSupportIndex()
    expect(newestVersion(index.product('rust')!)).toBe('1.91.1')
    expect(newestVersion(index.product('bun')!)).toBe('1.5.1')
  })
})

describe('deployed Dockerfiles', () => {
  const facts = (dockerfile: object | null) =>
    ({ dockerfile }) as unknown as Parameters<typeof deployedDockerfilePath>[0]

  it('joins the base directory and the location', () => {
    const at = (baseDirectory: string | null, location: string | null) =>
      deployedDockerfilePath(facts({ baseDirectory, location, target: null, inline: null }))
    expect(at('/apps/api', '/Dockerfile')).toBe('apps/api/Dockerfile')
    expect(at('/', '/Dockerfile.prod')).toBe('Dockerfile.prod')
    expect(at(null, null)).toBe('Dockerfile')
    expect(at('/apps/../..', '/Dockerfile')).toBeNull()
  })

  it('skips inline Dockerfiles and other build packs, and says nothing without facts', () => {
    const inline = facts({ baseDirectory: '/', location: '/Dockerfile', target: null, inline: {} })
    expect(deployedDockerfilePath(inline)).toBeNull()
    expect(deployedDockerfiles([{ facts: null }])).toBeUndefined()
    expect(deployedDockerfiles([{ facts: facts(null) }, { facts: null }])).toEqual(new Set())
  })
})
