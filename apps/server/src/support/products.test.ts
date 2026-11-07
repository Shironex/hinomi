import { describe, expect, it } from 'vitest'
import { parseProductsFull, SupportDataError } from './products.js'
import { bodyOf, fixtureData, fixtureText } from './testing.js'

const release = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: name,
  releaseDate: '2025-01-01',
  isLts: false,
  isEol: false,
  eolFrom: null,
  latest: null,
  ...extra,
})

const product = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  aliases: [],
  label: name,
  category: 'framework',
  labels: { eol: 'Security Support' },
  identifiers: [],
  releases: [release('1')],
  ...extra,
})

describe('parseProductsFull', () => {
  it('reads the recorded answer into products, lines and purls', () => {
    const data = fixtureData()
    expect(data.schemaVersion).toBe('1.2.1')
    expect(data.generatedAt).toBe('2026-11-07T02:38:40+00:00')
    expect([...data.products.keys()]).toEqual(['nodejs', 'bun', 'rust', 'nextjs', 'angular'])
    const node = data.products.get('nodejs')
    expect(node?.aliases).toEqual(['node'])
    expect(node?.eolLabel).toBe('Security Support')
    expect(node?.releases.map((r) => r.name)).toEqual(['26', '25', '24', '22', '20'])
    expect(node?.releases[0]).toMatchObject({
      isLts: true,
      ltsFrom: '2026-10-28',
      eoasFrom: '2027-10-27',
      eolFrom: '2029-04-30',
      latest: { name: '26.13.0', date: '2026-10-28' },
    })
    expect(data.products.get('angular')?.purls).toContain('npm/@angular/core')
    expect(data.skipped).toBe(0)
  })

  it('skips entries that do not fit and keeps the rest', () => {
    const data = parseProductsFull(
      bodyOf(
        product('good'),
        { name: 7 },
        'text',
        null,
        product('good', { label: 'a repeat' }),
        product('odd-dates', {
          releases: [
            release('1', { eolFrom: 'soon', releaseDate: 20250101, isEol: 'yes' }),
            { label: 'no name' },
            release('1'),
            release('2', { eolFrom: '2026-02-30' }),
          ],
          identifiers: [{ type: 'purl', id: 'not a purl' }, 'x', { type: 'cpe', id: 'cpe:x' }],
        }),
      ),
    )
    expect([...data.products.keys()]).toEqual(['good', 'odd-dates'])
    expect(data.products.get('good')?.label).toBe('good')
    expect(data.skipped).toBe(4)
    const odd = data.products.get('odd-dates')
    expect(odd?.releases.map((r) => [r.name, r.eolFrom, r.releaseDate, r.isEol])).toEqual([
      ['1', null, null, false],
      ['2', null, '2025-01-01', false],
    ])
    expect(odd?.purls).toEqual([])
  })

  it('throws when the answer is not a product list', () => {
    expect(() => parseProductsFull('<html>Not found</html>')).toThrow(SupportDataError)
    expect(() => parseProductsFull('{"result": 3}')).toThrow('no product list')
    expect(() => parseProductsFull('[]')).toThrow('no product list')
    expect(() => parseProductsFull(bodyOf())).toThrow('no usable products')
    expect(() => parseProductsFull(bodyOf({ name: '' }))).toThrow('no usable products')
  })

  it('keeps names from the response as plain keys, never as properties of an object', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      const data = parseProductsFull(
        bodyOf(
          product(name, {
            aliases: [name],
            releases: [release(name), release('1')],
            identifiers: [{ type: 'purl', id: `pkg:npm/${name}` }],
          }),
        ),
      )
      expect(data.products.get(name)?.releases.map((r) => r.name)).toEqual([name, '1'])
      expect(data.products.get(name)?.purls).toEqual([`npm/${name.toLowerCase()}`])
      expect(Object.keys({})).toEqual([])
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    }
  })

  it('parses a body whose own keys are __proto__ without polluting anything', () => {
    const body = fixtureText().replace(
      '"label": "Node.js"',
      '"__proto__": {"polluted": true}, "label": "Node.js"',
    )
    const data = parseProductsFull(body)
    expect(data.products.size).toBe(5)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
})
