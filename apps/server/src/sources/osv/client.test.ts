import type { OsvQuery } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createOsvClient, mapLimit, OsvRequestError } from './client.js'

const query = (name: string): OsvQuery => ({
  package: { name, ecosystem: 'npm' },
  version: '1.0.0',
})

type Body = { queries: (OsvQuery & { page_token?: string })[] }

describe('queryBatch', () => {
  it('splits queries into chunks of the batch size and keeps input order', async () => {
    const sizes: number[] = []
    const client = createOsvClient({
      batchSize: 2,
      fetch: (_url, init) => {
        const body = JSON.parse(init?.body as string) as Body
        sizes.push(body.queries.length)
        return Promise.resolve(
          Response.json({
            results: body.queries.map((q) => ({ vulns: [{ id: `V-${q.package.name}` }] })),
          }),
        )
      },
    })
    const ids = await client.queryBatch(['a', 'b', 'c', 'd', 'e'].map(query))
    expect(sizes).toEqual([2, 2, 1])
    expect(ids).toEqual([['V-a'], ['V-b'], ['V-c'], ['V-d'], ['V-e']])
  })

  it('never sends more than 1000 queries in one request', async () => {
    const sizes: number[] = []
    const client = createOsvClient({
      batchSize: 5000,
      fetch: (_url, init) => {
        const body = JSON.parse(init?.body as string) as Body
        sizes.push(body.queries.length)
        return Promise.resolve(Response.json({ results: body.queries.map(() => ({})) }))
      },
    })
    await client.queryBatch(Array.from({ length: 1500 }, (_, i) => query(`p${i}`)))
    expect(sizes).toEqual([1000, 500])
  })

  it('follows next_page_token only for the queries that have one', async () => {
    const bodies: Body[] = []
    const client = createOsvClient({
      fetch: (_url, init) => {
        const body = JSON.parse(init?.body as string) as Body
        bodies.push(body)
        if (bodies.length === 1) {
          return Promise.resolve(
            Response.json({
              results: [
                { vulns: [{ id: 'A1' }], next_page_token: 'tok-a' },
                { vulns: [{ id: 'B1' }] },
              ],
            }),
          )
        }
        return Promise.resolve(Response.json({ results: [{ vulns: [{ id: 'A2' }] }] }))
      },
    })
    const ids = await client.queryBatch([query('a'), query('b')])
    expect(ids).toEqual([['A1', 'A2'], ['B1']])
    expect(bodies[1]?.queries).toEqual([{ ...query('a'), page_token: 'tok-a' }])
  })
})

describe('retries', () => {
  it('backs off exponentially on 503 and network errors, then succeeds', async () => {
    const delays: number[] = []
    let attempt = 0
    const client = createOsvClient({
      baseDelayMs: 100,
      random: () => 0,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
      fetch: () => {
        attempt++
        if (attempt === 1) return Promise.resolve(new Response('busy', { status: 503 }))
        if (attempt === 2) return Promise.reject(new TypeError('socket hang up'))
        return Promise.resolve(Response.json({ results: [{}] }))
      },
    })
    expect(await client.queryBatch([query('a')])).toEqual([[]])
    expect(delays).toEqual([100, 200])
  })

  it('waits at least as long as Retry-After asks', async () => {
    const delays: number[] = []
    let attempt = 0
    const client = createOsvClient({
      baseDelayMs: 100,
      random: () => 0,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
      fetch: () =>
        Promise.resolve(
          ++attempt === 1
            ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } })
            : Response.json({ results: [{}] }),
        ),
    })
    await client.queryBatch([query('a')])
    expect(delays).toEqual([3000])
  })

  it('gives up after maxRetries', async () => {
    let calls = 0
    const client = createOsvClient({
      maxRetries: 2,
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls++
        return Promise.resolve(new Response('down', { status: 500 }))
      },
    })
    await expect(client.queryBatch([query('a')])).rejects.toBeInstanceOf(OsvRequestError)
    expect(calls).toBe(3)
  })

  it('does not retry a 400', async () => {
    let calls = 0
    const client = createOsvClient({
      sleep: () => Promise.resolve(),
      fetch: () => {
        calls++
        return Promise.resolve(new Response('bad', { status: 400 }))
      },
    })
    await expect(client.queryBatch([query('a')])).rejects.toMatchObject({ status: 400 })
    expect(calls).toBe(1)
  })
})

describe('getVulnerability', () => {
  it('caches details by id', async () => {
    let calls = 0
    const client = createOsvClient({
      fetch: () => {
        calls++
        return Promise.resolve(Response.json({ id: 'GHSA-aaaa-bbbb-cccc' }))
      },
    })
    await client.getVulnerability('GHSA-aaaa-bbbb-cccc')
    await client.getVulnerability('GHSA-aaaa-bbbb-cccc')
    expect(calls).toBe(1)
  })

  it('refetches after the cache entry expires and does not cache failures', async () => {
    let now = 0
    let calls = 0
    const client = createOsvClient({
      cacheTtlMs: 1000,
      maxRetries: 0,
      now: () => now,
      fetch: () => {
        calls++
        return Promise.resolve(
          calls === 1 ? new Response('no', { status: 404 }) : Response.json({ id: 'X-1' }),
        )
      },
    })
    await expect(client.getVulnerability('X-1')).rejects.toBeInstanceOf(OsvRequestError)
    await client.getVulnerability('X-1')
    expect(calls).toBe(2)
    now = 2000
    await client.getVulnerability('X-1')
    expect(calls).toBe(3)
  })

  it('limits parallel detail requests', async () => {
    let inFlight = 0
    let peak = 0
    const client = createOsvClient({
      concurrency: 2,
      fetch: async (url) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        const href = url as string
        const id = href.slice(href.lastIndexOf('/') + 1)
        return Response.json({ id })
      },
    })
    const vulns = await client.getVulnerabilities(['A', 'B', 'C', 'D', 'E'])
    expect(vulns.map((v) => v.id)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(peak).toBe(2)
  })
})

describe('mapLimit', () => {
  it('handles an empty list', async () => {
    expect(await mapLimit([], 3, () => Promise.resolve(1))).toEqual([])
  })
})

describe('ecosystems', () => {
  // The names OSV documents, spelled exactly: the client passes them through untouched.
  const cases: [string, string, string][] = [
    ['Go', 'example.dev/kestrel/router', '1.4.2'],
    ['PyPI', 'kestrel-client', '2.0.1'],
    ['Packagist', 'kestrel/laravel-bridge', '3.1.0'],
    ['RubyGems', 'kestrel-rails', '4.2.0'],
  ]
  it.each(cases)(
    'queries %s with its OSV name and reads the answer',
    async (ecosystem, name, version) => {
      const sent: OsvQuery[] = []
      const client = createOsvClient({
        fetch: (url, init) => {
          if (typeof url === 'string' && url.includes('/querybatch')) {
            const body = JSON.parse(init?.body as string) as Body
            sent.push(...body.queries)
            return Promise.resolve(
              Response.json({ results: [{ vulns: [{ id: `OSV-${ecosystem}-1` }] }] }),
            )
          }
          return Promise.resolve(
            Response.json({
              id: `OSV-${ecosystem}-1`,
              affected: [{ package: { name, ecosystem } }],
            }),
          )
        },
      })
      const ids = await client.queryBatch([{ package: { name, ecosystem }, version }])
      expect(sent).toEqual([{ package: { name, ecosystem }, version }])
      expect(ids).toEqual([[`OSV-${ecosystem}-1`]])
      const [vuln] = await client.getVulnerabilities(ids[0]!)
      expect(vuln?.affected?.[0]?.package?.ecosystem).toBe(ecosystem)
    },
  )
})

describe('queryPackage', () => {
  it('returns full records and follows next_page_token', async () => {
    const bodies: (OsvQuery & { page_token?: string })[] = []
    const urls: string[] = []
    const client = createOsvClient({
      fetch: (url, init) => {
        urls.push(url instanceof Request ? url.url : url.toString())
        const body = JSON.parse(init?.body as string) as OsvQuery & { page_token?: string }
        bodies.push(body)
        return Promise.resolve(
          Response.json(
            body.page_token
              ? { vulns: [{ id: 'DEBIAN-CVE-2026-0002', upstream: ['CVE-2026-0002'] }] }
              : { vulns: [{ id: 'DEBIAN-CVE-2026-0001' }], next_page_token: 'tok-1' },
          ),
        )
      },
    })
    const vulns = await client.queryPackage({
      package: { name: 'zlib', ecosystem: 'Debian:12' },
      version: '1:1.2.13.dfsg-1',
    })
    expect(vulns.map((v) => v.id)).toEqual(['DEBIAN-CVE-2026-0001', 'DEBIAN-CVE-2026-0002'])
    expect(vulns[1]?.upstream).toEqual(['CVE-2026-0002'])
    expect(urls[0]).toBe('https://api.osv.dev/v1/query')
    expect(bodies[1]?.page_token).toBe('tok-1')
  })

  it('stops after a bounded number of pages', async () => {
    let calls = 0
    const client = createOsvClient({
      fetch: () => {
        calls++
        return Promise.resolve(Response.json({ vulns: [], next_page_token: 'again' }))
      },
    })
    await client.queryPackage(query('loop'))
    expect(calls).toBe(10)
  })
})
