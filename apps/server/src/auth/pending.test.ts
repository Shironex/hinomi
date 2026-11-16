import { describe, expect, it } from 'vitest'
import { createPendingStore } from './pending.js'

describe('createPendingStore', () => {
  it('hands an entry out once', () => {
    const store = createPendingStore<number>({ ttlMs: 1000, now: () => 0 })
    store.put('a', 1)
    expect(store.take('a')).toBe(1)
    expect(store.take('a')).toBeUndefined()
  })

  it('caps each owner, pushing out only the oldest entries of that owner', () => {
    const store = createPendingStore<number>({ ttlMs: 1000, maxPerOwner: 3, now: () => 0 })
    store.put('quiet', 0, '198.51.100.7')
    for (let i = 0; i < 50; i++) store.put(`flood-${i}`, i, '203.0.113.9')
    expect(store.size).toBe(4)
    expect(store.take('quiet')).toBe(0)
    expect(store.take('flood-0')).toBeUndefined()
    expect(store.take('flood-49')).toBe(49)
  })

  it('drops the oldest entries when full, and expired ones first', () => {
    let at = 0
    const store = createPendingStore<number>({ ttlMs: 10, maxEntries: 2, now: () => at })
    store.put('a', 1)
    store.put('b', 2)
    store.put('c', 3)
    expect(store.take('a')).toBeUndefined()
    at = 20
    expect(store.take('b')).toBeUndefined()
  })
})
