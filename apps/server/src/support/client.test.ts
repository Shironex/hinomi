import { describe, expect, it, vi } from 'vitest'
import { fetchProductsFull, MAX_BODY_BYTES, parseRetryAfter } from './client.js'

// The client against a scripted fetch. Nothing here reaches the network.

type Step = Response | Error

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function script(...steps: Step[]) {
  const calls: { url: string; headers: Headers }[] = []
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(url), headers: new Headers(init?.headers) })
    const step = steps.shift()
    if (!step) return Promise.reject(new Error('no step planned'))
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers })

const noSleep = () => Promise.resolve()

describe('fetchProductsFull', () => {
  it('asks for products/full with the stored validators', async () => {
    const { fetchFn, calls } = script(
      json('{}', { etag: 'W/"b"', 'last-modified': 'Sat, 07 Nov 2026 02:38:40 GMT' }),
    )
    const result = await fetchProductsFull({
      fetch: fetchFn,
      validators: { etag: 'W/"a"', lastModified: 'Fri, 06 Nov 2026 00:00:00 GMT' },
    })
    expect(result).toEqual({
      kind: 'updated',
      body: '{}',
      etag: 'W/"b"',
      lastModified: 'Sat, 07 Nov 2026 02:38:40 GMT',
    })
    expect(calls[0]?.url).toBe('https://endoflife.date/api/v1/products/full')
    expect(calls[0]?.headers.get('if-none-match')).toBe('W/"a"')
    expect(calls[0]?.headers.get('if-modified-since')).toBeNull()
    expect(calls[0]?.headers.get('user-agent')).toBe('hinomi-support-data')
  })

  it('falls back to If-Modified-Since without an etag, and sends nothing without validators', async () => {
    const first = script(json('{}'))
    await fetchProductsFull({
      fetch: first.fetchFn,
      validators: { etag: null, lastModified: 'Fri, 06 Nov 2026 00:00:00 GMT' },
    })
    expect(first.calls[0]?.headers.get('if-modified-since')).toBe('Fri, 06 Nov 2026 00:00:00 GMT')
    const second = script(json('{}'))
    await fetchProductsFull({ fetch: second.fetchFn })
    expect(second.calls[0]?.headers.get('if-none-match')).toBeNull()
    expect(second.calls[0]?.headers.get('if-modified-since')).toBeNull()
  })

  it('answers not_modified to a 304', async () => {
    const { fetchFn } = script(new Response(null, { status: 304 }))
    expect(await fetchProductsFull({ fetch: fetchFn })).toEqual({ kind: 'not_modified' })
  })

  it('follows a 301 inside the API host, and refuses another host', async () => {
    const moved = script(
      new Response(null, { status: 301, headers: { location: '/api/v1/products/full/' } }),
      json('{"a":1}'),
    )
    expect(await fetchProductsFull({ fetch: moved.fetchFn })).toMatchObject({
      kind: 'updated',
      body: '{"a":1}',
    })
    expect(moved.calls.map((c) => c.url)).toEqual([
      'https://endoflife.date/api/v1/products/full',
      'https://endoflife.date/api/v1/products/full/',
    ])
    const away = script(
      new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.dev/x' } }),
    )
    expect(await fetchProductsFull({ fetch: away.fetchFn })).toEqual({
      kind: 'failed',
      reason: 'redirected to another host, not followed',
    })
    const loop = script(
      ...Array.from(
        { length: 5 },
        () => new Response(null, { status: 301, headers: { location: '/again' } }),
      ),
    )
    expect(await fetchProductsFull({ fetch: loop.fetchFn })).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('too many redirects') as string,
    })
  })

  it('waits out a short Retry-After on a 429 and then succeeds', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = script(
      new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
      json('{"ok":true}'),
    )
    expect(await fetchProductsFull({ fetch: fetchFn, sleep })).toMatchObject({ kind: 'updated' })
    expect(sleep).toHaveBeenCalledExactlyOnceWith(3000)
    expect(calls).toHaveLength(2)
  })

  it('backs off exponentially without a Retry-After and gives up after three tries', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = script(
      new Response(null, { status: 429 }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 429 }),
    )
    expect(await fetchProductsFull({ fetch: fetchFn, sleep })).toEqual({
      kind: 'failed',
      reason: 'endoflife.date answered 429',
    })
    expect(sleep.mock.calls).toEqual([[2000], [4000]])
    expect(calls).toHaveLength(3)
  })

  it('reports a long Retry-After to the caller instead of waiting for it', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = script(
      new Response(null, { status: 429, headers: { 'retry-after': '7200' } }),
    )
    expect(await fetchProductsFull({ fetch: fetchFn, sleep })).toEqual({
      kind: 'failed',
      reason: 'endoflife.date answered 429',
      retryAfterMs: 7_200_000,
    })
    expect(sleep).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('treats the HTML body of a 404 as not found, not as data', async () => {
    const { fetchFn } = script(
      new Response('<html>Not found</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    )
    expect(await fetchProductsFull({ fetch: fetchFn })).toEqual({
      kind: 'failed',
      reason: 'endoflife.date answered 404',
    })
  })

  it('fails with a reason on a network error and on a timeout', async () => {
    const down = script(new TypeError('fetch failed'))
    expect(await fetchProductsFull({ fetch: down.fetchFn })).toEqual({
      kind: 'failed',
      reason: 'fetch failed',
    })
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        }),
    ) as unknown as typeof fetch
    expect(await fetchProductsFull({ fetch: hang, timeoutMs: 5 })).toEqual({
      kind: 'failed',
      reason: 'the request timed out',
    })
  })

  it('refuses an answer larger than the limit, declared or streamed', async () => {
    const declared = script(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      }),
    )
    expect(await fetchProductsFull({ fetch: declared.fetchFn })).toMatchObject({
      kind: 'failed',
      reason: 'the answer is larger than expected',
    })
    const chunk = new Uint8Array(MAX_BODY_BYTES / 2 + 1)
    const streamed = script(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk)
          },
        }),
        { status: 200 },
      ),
    )
    expect(await fetchProductsFull({ fetch: streamed.fetchFn })).toMatchObject({
      kind: 'failed',
      reason: 'the answer is larger than expected',
    })
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and nothing else', () => {
    const now = Date.parse('2026-11-07T12:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter('Sat, 07 Nov 2026 12:01:00 GMT', now)).toBe(60_000)
    expect(parseRetryAfter('Sat, 07 Nov 2026 11:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })
})
