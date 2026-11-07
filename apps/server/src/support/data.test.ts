import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import {
  createSupportData,
  IDLE_RECHECK_MS,
  PRODUCTS_FULL_KEY,
  REFRESH_INTERVAL_MS,
  type SupportDataOptions,
} from './data.js'
import { bodyOf, FIXTURE_ETAG, FIXTURE_NOW, fixtureText } from './testing.js'

let repos: Repositories
let handle: DatabaseHandle
let clock = FIXTURE_NOW

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  clock = FIXTURE_NOW
})
afterEach(() => handle.close())

const DAY = 24 * 60 * 60 * 1000
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

type Step = Response | Error

/** A scripted API. The conditional request is answered like the real one: 304 on a matching etag. */
function api(...steps: Step[]) {
  const seen: Headers[] = []
  const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    const step = steps.shift()
    if (!step) return Promise.reject(new Error('no step planned'))
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step)
  }) as unknown as typeof fetch
  return { fetchFn, seen, steps }
}

const ok = (body = fixtureText(), etag = FIXTURE_ETAG) =>
  new Response(body, { status: 200, headers: { etag } })
const notModified = () => new Response(null, { status: 304 })

function create(fetchFn: typeof fetch, extra: Partial<SupportDataOptions> = {}) {
  return createSupportData({
    cache: repos.httpCache,
    fetch: fetchFn,
    now: () => clock,
    sleep: () => Promise.resolve(),
    ...extra,
  })
}

describe('support data', () => {
  it('has no data and says so before the first fetch', () => {
    const data = create(api().fetchFn)
    expect(data.index()).toBeNull()
    expect(data.status()).toMatchObject({
      source: 'none',
      fetchedAt: null,
      ageSeconds: null,
      stale: false,
      generatedAt: null,
      counts: { products: 0, releases: 0, purls: 0 },
      lastAttemptAt: null,
      lastError: null,
      nextRefreshAt: null,
    })
    expect(data.status().runtimes).toEqual([
      { runtime: 'node', product: 'nodejs', found: false, basis: null, lines: 0 },
      { runtime: 'bun', product: 'bun', found: false, basis: null, lines: 0 },
      { runtime: 'rust', product: 'rust', found: false, basis: null, lines: 0 },
    ])
  })

  it('stores the answer gzipped, indexes it and reports it as live', async () => {
    const script = api(ok())
    const data = create(script.fetchFn)
    expect(await data.refresh()).toEqual({ kind: 'updated' })
    const row = repos.httpCache.get(PRODUCTS_FULL_KEY)
    expect(row).toMatchObject({ etag: FIXTURE_ETAG, status: 200, fetchedAt: FIXTURE_NOW })
    expect(row?.body.length).toBeLessThan(fixtureText().length)
    expect(row?.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(data.index()?.product('nodejs')?.name).toBe('nodejs')
    expect(script.seen[0]?.get('if-none-match')).toBeNull()
    expect(data.status()).toMatchObject({
      source: 'live',
      fetchedAt: FIXTURE_NOW.toISOString(),
      ageSeconds: 0,
      stale: false,
      generatedAt: '2026-11-07T02:38:40+00:00',
      schemaVersion: '1.2.1',
      counts: { products: 5, releases: 22, purls: 11 },
      lastError: null,
    })
    expect(data.status().runtimes).toEqual([
      { runtime: 'node', product: 'nodejs', found: true, basis: 'security', lines: 5 },
      { runtime: 'bun', product: 'bun', found: true, basis: 'release_cycle', lines: 1 },
      { runtime: 'rust', product: 'rust', found: true, basis: 'release_cycle', lines: 4 },
    ])
  })

  it('sends the etag back and only moves the check time on a 304', async () => {
    const script = api(ok(), notModified())
    const data = create(script.fetchFn)
    await data.refresh()
    const before = repos.httpCache.get(PRODUCTS_FULL_KEY)?.body
    advance(DAY)
    expect(await data.refresh()).toEqual({ kind: 'not_modified' })
    expect(script.seen[1]?.get('if-none-match')).toBe(FIXTURE_ETAG)
    const row = repos.httpCache.get(PRODUCTS_FULL_KEY)
    expect(row?.fetchedAt).toEqual(clock)
    expect(row?.body).toEqual(before)
    expect(data.status()).toMatchObject({ source: 'live', ageSeconds: 0 })
  })

  it('serves the stored copy after a restart without asking the network', () => {
    repos.httpCache.put({
      key: PRODUCTS_FULL_KEY,
      etag: FIXTURE_ETAG,
      lastModified: null,
      fetchedAt: new Date(FIXTURE_NOW.getTime() - 3 * DAY),
      status: 200,
      body: gzipSync(Buffer.from(fixtureText())),
    })
    const script = api()
    const data = create(script.fetchFn)
    expect(script.fetchFn).not.toHaveBeenCalled()
    expect(data.index()?.lookupRuntime('node', '22', { now: clock, windowDays: 90 })?.line).toBe(
      '22',
    )
    expect(data.status()).toMatchObject({ source: 'cache', ageSeconds: 3 * 86400, stale: false })
  })

  it('keeps the last copy when the fetch fails, and reports its age and the error', async () => {
    const script = api(ok(), new TypeError('fetch failed'))
    const data = create(script.fetchFn)
    await data.refresh()
    advance(9 * DAY)
    expect(await data.refresh()).toEqual({ kind: 'failed', reason: 'fetch failed' })
    expect(script.seen[1]?.get('if-none-match')).toBe(FIXTURE_ETAG)
    expect(data.index()).not.toBeNull()
    expect(data.status()).toMatchObject({
      source: 'live',
      ageSeconds: 9 * 86400,
      stale: true,
      staleAfterDays: 7,
      lastError: 'fetch failed',
      lastAttemptAt: clock.toISOString(),
    })
  })

  it('never replaces a good copy with an answer it cannot use', async () => {
    const script = api(ok(), ok('<html>maintenance</html>'), ok(bodyOf()), ok(bodyOf({ name: '' })))
    const data = create(script.fetchFn)
    await data.refresh()
    for (let i = 0; i < 3; i++) {
      expect((await data.refresh()).kind).toBe('failed')
    }
    expect(data.status().lastError).toContain('unusable answer')
    expect(data.status().counts.products).toBe(5)
    const row = repos.httpCache.get(PRODUCTS_FULL_KEY)
    expect(row?.etag).toBe(FIXTURE_ETAG)
    expect(row?.fetchedAt).toEqual(FIXTURE_NOW)
  })

  it('works from nothing when the stored copy is unreadable, and asks unconditionally', async () => {
    repos.httpCache.put({
      key: PRODUCTS_FULL_KEY,
      etag: 'W/"old"',
      lastModified: null,
      fetchedAt: FIXTURE_NOW,
      status: 200,
      body: Buffer.from('not gzip'),
    })
    const script = api(ok())
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const data = create(script.fetchFn, { log })
    expect(data.index()).toBeNull()
    expect(log.warn).toHaveBeenCalledOnce()
    await data.refresh()
    expect(script.seen[0]?.get('if-none-match')).toBeNull()
    expect(data.index()).not.toBeNull()
  })

  it('shares one request between concurrent refreshes', async () => {
    const script = api(ok())
    const data = create(script.fetchFn)
    const [a, b] = await Promise.all([data.refresh(), data.refresh()])
    expect(a).toEqual(b)
    expect(script.fetchFn).toHaveBeenCalledOnce()
  })
})

describe('the daily tick', () => {
  it('fetches nothing while nothing needs the data', async () => {
    const script = api()
    const data = create(script.fetchFn, { demand: () => false })
    expect(await data.tick()).toEqual({ nextDelayMs: IDLE_RECHECK_MS })
    expect(script.fetchFn).not.toHaveBeenCalled()
    expect(data.status().nextRefreshAt).toBe(
      new Date(FIXTURE_NOW.getTime() + IDLE_RECHECK_MS).toISOString(),
    )
  })

  it('fetches when demanded and plans the next look a day later', async () => {
    let wanted = false
    const script = api(ok())
    const data = create(script.fetchFn, { demand: () => wanted })
    await data.tick()
    wanted = true
    expect(await data.tick()).toEqual({ nextDelayMs: REFRESH_INTERVAL_MS })
    expect(script.fetchFn).toHaveBeenCalledOnce()
  })

  it('leaves a copy under a day old alone and plans for the rest of the day', async () => {
    const script = api(ok(), notModified())
    const data = create(script.fetchFn)
    await data.tick()
    advance(5 * 60 * 60 * 1000)
    expect(await data.tick()).toEqual({ nextDelayMs: REFRESH_INTERVAL_MS - 5 * 60 * 60 * 1000 })
    expect(script.fetchFn).toHaveBeenCalledOnce()
    advance(REFRESH_INTERVAL_MS)
    expect(await data.tick()).toEqual({ nextDelayMs: REFRESH_INTERVAL_MS })
    expect(script.fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not fetch on boot when the stored copy is fresh', async () => {
    repos.httpCache.put({
      key: PRODUCTS_FULL_KEY,
      etag: FIXTURE_ETAG,
      lastModified: null,
      fetchedAt: new Date(FIXTURE_NOW.getTime() - 3 * 60 * 60 * 1000),
      status: 200,
      body: gzipSync(Buffer.from(fixtureText())),
    })
    const script = api()
    const data = create(script.fetchFn)
    expect(await data.tick()).toEqual({ nextDelayMs: REFRESH_INTERVAL_MS - 3 * 60 * 60 * 1000 })
    expect(script.fetchFn).not.toHaveBeenCalled()
  })

  it('backs off after failures and honours a Retry-After longer than the backoff', async () => {
    const script = api(
      new TypeError('offline'),
      new TypeError('offline'),
      new Response(null, { status: 429, headers: { 'retry-after': '36000' } }),
    )
    const data = create(script.fetchFn)
    const first = await data.tick()
    const second = await data.tick()
    const third = await data.tick()
    expect(first.nextDelayMs).toBe(30 * 60 * 1000)
    expect(second.nextDelayMs).toBe(60 * 60 * 1000)
    expect(third.nextDelayMs).toBe(36_000_000)
    expect(data.status().lastError).toBe('endoflife.date answered 429')
  })
})
