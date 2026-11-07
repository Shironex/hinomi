import { describe, expect, it } from 'vitest'
import { watchPathRegExp, watchPathsTrigger } from './watch-paths.js'

describe('watch paths', () => {
  it('matches like Coolify: ** crosses folders, * and ? do not', () => {
    expect(watchPathRegExp('apps/api/**').test('apps/api/src/index.ts')).toBe(true)
    expect(watchPathRegExp('apps/*/package.json').test('apps/api/package.json')).toBe(true)
    expect(watchPathRegExp('apps/*/package.json').test('apps/api/nested/package.json')).toBe(false)
    expect(watchPathRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(watchPathRegExp('v?.txt').test('v1.txt')).toBe(true)
    expect(watchPathRegExp('pnpm-lock.yaml').test('pnpm-lockxyaml')).toBe(false)
  })

  it('reads patterns in order and lets the last match win', () => {
    const patterns = ['apps/api/**', '!apps/api/**/*.md']
    expect(watchPathsTrigger(patterns, 'apps/api/src/a.ts')).toBe(true)
    expect(watchPathsTrigger(patterns, 'apps/api/docs/readme.md')).toBe(false)
    expect(watchPathsTrigger([...patterns, 'apps/api/docs/**'], 'apps/api/docs/readme.md')).toBe(
      true,
    )
    expect(watchPathsTrigger([], 'anything')).toBe(true)
    expect(watchPathsTrigger(['', '  '], 'anything')).toBe(true)
  })
})
