import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGithubClient } from './client.js'
import { GithubError, GithubRateLimitError } from './errors.js'
import { scriptedFetch } from './testing.js'

const BASE = 'https://github.example.dev'

function client(responses: Parameters<typeof scriptedFetch>[0], extra = {}) {
  const { fetch, requests } = scriptedFetch(responses)
  return {
    requests,
    client: createGithubClient({ token: 'test-token', baseUrl: BASE, fetch, ...extra }),
  }
}

describe('github client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the token and parses JSON', async () => {
    const { client: c, requests } = client([{ body: { login: 'octo-kestrel' } }])
    const result = await c.rest('/user')
    expect(result.data).toEqual({ login: 'octo-kestrel' })
    expect(requests[0]?.url).toBe(`${BASE}/user`)
  })

  it('maps statuses to typed errors', async () => {
    await expect(client([{ status: 401 }]).client.rest('/user')).rejects.toMatchObject({
      kind: 'auth',
    })
    await expect(
      client([{ status: 403, body: { message: 'nope' } }]).client.rest('/x'),
    ).rejects.toMatchObject({
      kind: 'permission',
    })
    await expect(client([{ status: 404 }]).client.rest('/x')).rejects.toMatchObject({
      kind: 'not_found',
    })
    await expect(client([{ status: 422 }]).client.rest('/x')).rejects.toMatchObject({
      kind: 'http',
      status: 422,
    })
  })

  it('returns accepted statuses instead of throwing', async () => {
    const { client: c } = client([{ status: 404 }])
    const result = await c.rest('/x', { acceptStatus: [404] })
    expect(result.status).toBe(404)
  })

  it('waits for retry-after on a secondary rate limit and never retries earlier', async () => {
    const { client: c, requests } = client([
      { status: 403, headers: { 'retry-after': '30' }, body: { message: 'secondary rate limit' } },
      { body: { ok: true } },
    ])
    const promise = c.rest('/x')
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toMatchObject({ data: { ok: true } })
    expect(requests).toHaveLength(2)
  })

  it('waits until x-ratelimit-reset when the budget is spent', async () => {
    const reset = Math.floor(Date.now() / 1000) + 10
    const { client: c, requests } = client([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      },
      { body: {} },
    ])
    const promise = c.rest('/x')
    await vi.advanceTimersByTimeAsync(10_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(requests).toHaveLength(2)
  })

  it('holds the next request after the last call used the budget', async () => {
    const reset = Math.floor(Date.now() / 1000) + 5
    const { client: c, requests } = client([
      { body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
      { body: {} },
    ])
    await c.rest('/a')
    const second = c.rest('/b')
    await vi.advanceTimersByTimeAsync(5_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(requests).toHaveLength(2)
  })

  it('throws a rate limit error when the window is longer than maxWaitMs', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    const { client: c, requests } = client(
      [{ status: 429, headers: { 'x-ratelimit-reset': String(reset) } }],
      { maxWaitMs: 60_000 },
    )
    const error = await c.rest('/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GithubRateLimitError)
    expect((error as GithubRateLimitError).retryAt).toBeGreaterThan(Date.now())
    expect(requests).toHaveLength(1)
  })

  it('backs off exponentially on 5xx and gives up after maxRetries', async () => {
    const { client: c, requests } = client([{ status: 502 }, { status: 502 }, { status: 502 }], {
      maxRetries: 2,
      backoffBaseMs: 100,
    })
    const promise = c.rest('/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(99)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const error = await promise
    expect(error).toMatchObject({ kind: 'http', status: 502 })
    expect(requests).toHaveLength(3)
  })

  it('retries a network failure and then succeeds', async () => {
    const { client: c } = client([new Error('socket hang up'), { body: { ok: 1 } }], {
      backoffBaseMs: 50,
    })
    const promise = c.rest('/x')
    await vi.advanceTimersByTimeAsync(50)
    await expect(promise).resolves.toMatchObject({ data: { ok: 1 } })
  })

  it('times out a request that never answers', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof globalThis.fetch
    const c = createGithubClient({
      token: 't',
      baseUrl: BASE,
      fetch,
      timeoutMs: 1000,
      maxRetries: 0,
    })
    const promise = c.rest('/x').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await promise).toMatchObject({ kind: 'timeout' })
  })

  it('maps GraphQL errors by type', async () => {
    const notFound = client([{ body: { errors: [{ type: 'NOT_FOUND', message: 'no repo' }] } }])
    await expect(notFound.client.graphql('query {}')).rejects.toMatchObject({ kind: 'not_found' })
    const other = client([{ body: { errors: [{ message: 'boom' }] } }])
    const error = await other.client.graphql('query {}').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GithubError)
    expect(error).toMatchObject({ kind: 'graphql' })
  })

  it('backs off on a GraphQL RATE_LIMITED error', async () => {
    const reset = Math.floor(Date.now() / 1000) + 20
    const { client: c, requests } = client([
      {
        headers: { 'x-ratelimit-reset': String(reset) },
        body: { errors: [{ type: 'RATE_LIMITED', message: 'limited' }] },
      },
      { body: { data: { ok: true } } },
    ])
    const promise = c.graphql('query {}')
    await vi.advanceTimersByTimeAsync(20_999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toEqual({ ok: true })
  })
})
