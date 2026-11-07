import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from './index.js'

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

const entry = (body: string, etag: string | null = 'W/"a"') => ({
  key: 'eol:products-full',
  etag,
  lastModified: null,
  fetchedAt: new Date('2026-11-07T10:00:00.000Z'),
  status: 200,
  body: Buffer.from(body),
})

describe('http cache', () => {
  it('stores, replaces and reads an entry with its bytes intact', () => {
    expect(repos.httpCache.get('eol:products-full')).toBeNull()
    repos.httpCache.put(entry('one'))
    repos.httpCache.put({
      ...entry('two', 'W/"b"'),
      fetchedAt: new Date('2026-11-08T10:00:00.000Z'),
    })
    const stored = repos.httpCache.get('eol:products-full')
    expect(stored?.body.toString()).toBe('two')
    expect(stored?.etag).toBe('W/"b"')
    expect(stored?.fetchedAt).toEqual(new Date('2026-11-08T10:00:00.000Z'))
  })

  it('moves only the check time on a touch, and removes', () => {
    repos.httpCache.put(entry('one'))
    const later = new Date('2026-11-09T10:00:00.000Z')
    expect(repos.httpCache.touch('eol:products-full', later)).toBe(true)
    expect(repos.httpCache.touch('missing', later)).toBe(false)
    const stored = repos.httpCache.get('eol:products-full')
    expect(stored?.body.toString()).toBe('one')
    expect(stored?.fetchedAt).toEqual(later)
    expect(repos.httpCache.remove('eol:products-full')).toBe(true)
    expect(repos.httpCache.get('eol:products-full')).toBeNull()
  })
})
