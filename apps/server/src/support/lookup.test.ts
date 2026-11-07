import { RUNTIMES, RUNTIME_PRODUCTS } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  createSupportIndex,
  daysUntilEol,
  lineCandidates,
  supportBasisOf,
  windowStateOf,
} from './lookup.js'
import { parseProductsFull, type SupportRelease } from './products.js'
import { normalizePurl, purlKey } from './purl.js'
import { bodyOf, fixtureData, FIXTURE_NOW } from './testing.js'

const index = createSupportIndex(fixtureData())
const at = (now: Date = FIXTURE_NOW, windowDays = 90) => ({ now, windowDays })

const line = (extra: Partial<SupportRelease>): SupportRelease => ({
  name: '1',
  label: '1',
  releaseDate: null,
  isLts: false,
  ltsFrom: null,
  isEoas: null,
  eoasFrom: null,
  isEol: false,
  eolFrom: null,
  latest: null,
  ...extra,
})

describe('runtime products (Q12), against the recorded answer', () => {
  it('has the product of every runtime', () => {
    for (const runtime of RUNTIMES) {
      expect(index.product(RUNTIME_PRODUCTS[runtime])?.name).toBe(RUNTIME_PRODUCTS[runtime])
    }
  })

  it('nodejs publishes security support dates, active support and LTS', () => {
    const node = index.product('nodejs')
    expect(node && supportBasisOf(node)).toBe('security')
    expect(index.lookupRuntime('node', '24.22.2', at())).toEqual({
      product: 'nodejs',
      basis: 'security',
      line: '24',
      label: '24 (LTS)',
      releaseDate: '2025-05-06',
      isLts: true,
      ltsFrom: '2025-10-28',
      eoasFrom: '2026-10-20',
      eolFrom: '2028-04-30',
      latest: '24.22.2',
      state: 'maintenance',
      daysToEol: 539,
    })
    expect(index.product('node')?.name).toBe('nodejs')
  })

  it('bun has one line with no end date, so it is on the release cycle and reads as supported', () => {
    const bun = index.product('bun')
    expect(bun && supportBasisOf(bun)).toBe('release_cycle')
    expect(index.lookupRuntime('bun', '1.4.4', at())).toMatchObject({
      product: 'bun',
      basis: 'release_cycle',
      line: '1',
      eoasFrom: null,
      eolFrom: null,
      state: 'supported',
      daysToEol: null,
    })
  })

  it('rust publishes no security date: a line ends when the next one is released', () => {
    const rust = index.product('rust')
    expect(rust && supportBasisOf(rust)).toBe('release_cycle')
    expect(index.lookupRuntime('rust', '1.99.1', at())).toMatchObject({
      basis: 'release_cycle',
      line: '1.99',
      eolFrom: null,
      state: 'supported',
    })
    expect(index.lookupRuntime('rust', '1.98.1', at())).toMatchObject({
      line: '1.98',
      eolFrom: '2026-10-01',
      state: 'eol',
    })
  })
})

describe('line lookup and window states', () => {
  it('finds the line of a version by its most specific known prefix', () => {
    expect(index.lookup('nodejs', '22', at())?.line).toBe('22')
    expect(index.lookup('nodejs', 'v22.11.0', at())?.line).toBe('22')
    expect(index.lookup('nodejs', '22.0.0-rc.1', at())?.line).toBe('22')
    expect(index.lookup('nextjs', '15.0.3', at())?.line).toBe('15')
    expect(index.lookup('nodejs', '23', at())).toBeNull()
    expect(index.lookup('nodejs', '2', at())).toBeNull()
    expect(index.lookup('no-such-product', '1', at())).toBeNull()
    expect(index.line('nodejs', '24.1.0')?.name).toBe('24')
  })

  it('reads supported, maintenance, ending and end of life from the dates', () => {
    const state = (version: string, windowDays = 90) =>
      index.lookup('nodejs', version, at(FIXTURE_NOW, windowDays))?.state
    expect(state('26')).toBe('supported')
    expect(state('24')).toBe('maintenance')
    // 22 ends 2027-04-30, 174 days out.
    expect(state('22')).toBe('maintenance')
    expect(state('22', 174)).toBe('ending')
    expect(state('20')).toBe('eol')
    expect(state('25')).toBe('eol')
  })

  it('ends on the day itself, and counts the window inclusively', () => {
    const release = line({ eolFrom: '2026-12-01' })
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
    expect(windowStateOf(release, day('2026-11-30'), 90)).toBe('ending')
    expect(windowStateOf(release, day('2026-12-01'), 90)).toBe('eol')
    expect(windowStateOf(release, day('2026-09-02'), 90)).toBe('ending')
    expect(windowStateOf(release, day('2026-09-01'), 90)).toBe('supported')
    expect(daysUntilEol(release, day('2026-11-30'))).toBe(1)
    expect(daysUntilEol(release, day('2026-12-03'))).toBe(-2)
  })

  it('trusts the date over the flag of a stale copy, and the flag when there is no date', () => {
    expect(windowStateOf(line({ eolFrom: '2026-01-01', isEol: false }), FIXTURE_NOW, 90)).toBe(
      'eol',
    )
    expect(windowStateOf(line({ eolFrom: '2030-01-01', isEol: true }), FIXTURE_NOW, 90)).toBe(
      'supported',
    )
    expect(windowStateOf(line({ isEol: true }), FIXTURE_NOW, 90)).toBe('eol')
    expect(windowStateOf(line({ isEoas: true }), FIXTURE_NOW, 90)).toBe('maintenance')
  })

  it('has the right basis for a product by its data', () => {
    const data = parseProductsFull(
      bodyOf(
        {
          name: 'a',
          labels: { eol: 'Security Support' },
          releases: [{ name: '1', eolFrom: '2030-01-01' }],
        },
        { name: 'b', labels: { eol: 'Security Support' }, releases: [{ name: '1' }] },
        {
          name: 'c',
          labels: { eol: 'Supported' },
          releases: [{ name: '1', eolFrom: '2030-01-01' }],
        },
        { name: 'd', releases: [{ name: '1', eolFrom: '2030-01-01' }] },
      ),
    )
    const basis = [...data.products.values()].map((p) => supportBasisOf(p))
    expect(basis).toEqual(['security', 'release_cycle', 'release_cycle', 'release_cycle'])
  })

  it('splits versions into candidates and refuses odd ones', () => {
    expect(lineCandidates('22.11.0')).toEqual(['22.11.0', '22.11', '22'])
    expect(lineCandidates(' V1.99.1+build.5 ')).toEqual(['1.99.1', '1.99', '1'])
    expect(lineCandidates('')).toEqual([])
    expect(lineCandidates('1..2')).toEqual([])
    expect(lineCandidates('1.2.3.4.5.6.7.8.9')).toEqual([])
    expect(lineCandidates('9'.repeat(65))).toEqual([])
  })
})

describe('purl index', () => {
  it('normalises purls from the API and from manifests to one key', () => {
    expect(normalizePurl('pkg:npm/%40angular/core')).toBe('npm/@angular/core')
    expect(normalizePurl('pkg:npm/@angular/core@19.0.0')).toBe('npm/@angular/core')
    expect(normalizePurl('pkg:npm/next@15.0.3?arch=x#sub/path')).toBe('npm/next')
    expect(normalizePurl('PKG:NPM/Next')).toBe('npm/next')
    expect(normalizePurl('pkg:docker/library/node')).toBe('docker/library/node')
    expect(normalizePurl('pkg:npm')).toBeNull()
    expect(normalizePurl('npm/next')).toBeNull()
    expect(normalizePurl('pkg:npm//next')).toBeNull()
    expect(purlKey('npm', '@angular/core')).toBe('npm/@angular/core')
    expect(purlKey('npm', '')).toBeNull()
  })

  it('finds the product that publishes a package identifier', () => {
    expect(index.productsForPurl('pkg:npm/next').map((p) => p.name)).toEqual(['nextjs'])
    expect(index.productsForPurl('pkg:npm/next@15.0.3').map((p) => p.name)).toEqual(['nextjs'])
    expect(index.productsForPurl('pkg:npm/%40angular/core').map((p) => p.name)).toEqual(['angular'])
    expect(index.productsForPurl('pkg:npm/@angular/core').map((p) => p.name)).toEqual(['angular'])
    expect(index.productsForPurl('pkg:docker/library/node').map((p) => p.name)).toEqual(['nodejs'])
    expect(index.productsForPurl('pkg:docker/oven/bun').map((p) => p.name)).toEqual(['bun'])
    expect(index.productsForPurl('pkg:npm/left-pad')).toEqual([])
    expect(index.productsForPurl('garbage')).toEqual([])
    expect(index.counts()).toEqual({ products: 5, releases: 22, purls: 11 })
  })

  it('is safe against names that are keys of Object.prototype', () => {
    const hostile = createSupportIndex(
      parseProductsFull(
        bodyOf({
          name: '__proto__',
          aliases: ['constructor', 'prototype'],
          identifiers: [{ type: 'purl', id: 'pkg:npm/constructor' }],
          releases: [{ name: '__proto__' }, { name: 'constructor' }],
        }),
      ),
    )
    const now = at()
    expect(hostile.product('__proto__')?.name).toBe('__proto__')
    expect(hostile.product('constructor')?.name).toBe('__proto__')
    expect(hostile.product('toString')).toBeNull()
    expect(hostile.product('hasOwnProperty')).toBeNull()
    expect(hostile.lookup('__proto__', 'constructor', now)?.line).toBe('constructor')
    expect(hostile.lookup('__proto__', 'valueOf', now)).toBeNull()
    expect(hostile.productsForPurl('pkg:npm/constructor').map((p) => p.name)).toEqual(['__proto__'])
    expect(hostile.productsForPurl('pkg:npm/__proto__')).toEqual([])
    expect(hostile.productsForPurl('pkg:npm/prototype')).toEqual([])
    expect(index.product('__proto__')).toBeNull()
    expect(index.lookup('nodejs', '__proto__', now)).toBeNull()
    expect(({} as Record<string, unknown>)['name']).toBeUndefined()
  })
})
