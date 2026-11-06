import { describe, expect, it } from 'vitest'
import {
  hasPublicDomain,
  joinImage,
  normalizeRepo,
  parseDomains,
  parseWatchPaths,
} from './normalize.js'

describe('normalizeRepo', () => {
  it.each([
    ['https://github.com/kestrel-co/web.git', 'kestrel-co/web'],
    ['https://github.com/kestrel-co/web', 'kestrel-co/web'],
    ['https://github.com/kestrel-co/web/', 'kestrel-co/web'],
    ['https://github.com/kestrel-co/web/tree/main/apps', 'kestrel-co/web'],
    ['git@github.com:kestrel-co/api.git', 'kestrel-co/api'],
    ['ssh://git@github.com/kestrel-co/api.git', 'kestrel-co/api'],
    ['github.com/kestrel-co/api', 'kestrel-co/api'],
    ['kestrel-co/worker', 'kestrel-co/worker'],
    ['  kestrel-co/worker.git ', 'kestrel-co/worker'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRepo(input)).toBe(expected)
  })

  it.each([null, undefined, '', '   ', 'justaname', 'https://github.com/', 42])(
    'rejects %j',
    (input) => {
      expect(normalizeRepo(input)).toBeNull()
    },
  )
})

describe('domains', () => {
  it('splits, trims and dedupes', () => {
    expect(
      parseDomains('https://a.example.dev, https://a.example.dev/ ,http://b.example.dev'),
    ).toEqual(['https://a.example.dev', 'http://b.example.dev'])
    expect(parseDomains(null)).toEqual([])
    expect(parseDomains('')).toEqual([])
  })

  it('is public only with an http(s) domain', () => {
    expect(hasPublicDomain(['https://a.example.dev'])).toBe(true)
    expect(hasPublicDomain(['http://a.example.dev'])).toBe(true)
    expect(hasPublicDomain(['a.example.dev'])).toBe(false)
    expect(hasPublicDomain([])).toBe(false)
  })
})

describe('misc helpers', () => {
  it('joins image and tag', () => {
    expect(joinImage('ghcr.io/kestrel-co/docs', '1.4')).toBe('ghcr.io/kestrel-co/docs:1.4')
    expect(joinImage('redis:7', 'latest')).toBe('redis:7')
    expect(joinImage(null, '1')).toBeNull()
  })

  it('parses watch paths', () => {
    expect(parseWatchPaths('a/**\n b/** ,c')).toEqual(['a/**', 'b/**', 'c'])
    expect(parseWatchPaths(undefined)).toBeNull()
  })
})
