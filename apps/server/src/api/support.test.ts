import { gzipSync } from 'node:zlib'
import { supportStatusSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createSupportData, PRODUCTS_FULL_KEY, type SupportData } from '../support/index.js'
import { FIXTURE_ETAG, FIXTURE_NOW, fixtureText } from '../support/testing.js'
import { createTestApi } from './testing.js'

describe('GET /api/support/status', () => {
  it('reports no data on a fresh install, without fetching anything', async () => {
    const { call } = createTestApi()
    const res = await call('GET', '/support/status')
    expect(res.status).toBe(200)
    const body = supportStatusSchema.parse(res.json)
    expect(body).toMatchObject({
      source: 'none',
      fetchedAt: null,
      ageSeconds: null,
      stale: false,
      staleAfterDays: 7,
      counts: { products: 0, releases: 0, purls: 0 },
      lastError: null,
    })
    expect(body.runtimes.map((r) => [r.runtime, r.product, r.found])).toEqual([
      ['node', 'nodejs', false],
      ['bun', 'bun', false],
      ['rust', 'rust', false],
    ])
  })

  it('reports the cache: age, source, counts and what each runtime publishes', async () => {
    const held: { data?: SupportData } = {}
    const { repos, call } = createTestApi({
      support: { status: () => (held.data as SupportData).status() },
    })
    repos.httpCache.put({
      key: PRODUCTS_FULL_KEY,
      etag: FIXTURE_ETAG,
      lastModified: null,
      fetchedAt: FIXTURE_NOW,
      status: 200,
      body: gzipSync(Buffer.from(fixtureText())),
    })
    held.data = createSupportData({
      cache: repos.httpCache,
      now: () => new Date(FIXTURE_NOW.getTime() + 8 * 86_400_000),
      demand: () => false,
    })
    const res = await call('GET', '/support/status')
    expect(res.status).toBe(200)
    expect(supportStatusSchema.parse(res.json)).toMatchObject({
      source: 'cache',
      fetchedAt: FIXTURE_NOW.toISOString(),
      ageSeconds: 8 * 86_400,
      stale: true,
      generatedAt: '2026-11-07T02:38:40+00:00',
      counts: { products: 5, releases: 22, purls: 11 },
      runtimes: [
        { runtime: 'node', product: 'nodejs', found: true, basis: 'security', lines: 5 },
        { runtime: 'bun', product: 'bun', found: true, basis: 'release_cycle', lines: 1 },
        { runtime: 'rust', product: 'rust', found: true, basis: 'release_cycle', lines: 4 },
      ],
    })
  })
})
