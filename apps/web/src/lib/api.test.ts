import { healthResponseSchema } from '@hinomi/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefixes /api and returns the parsed body', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(Response.json({ status: 'ok' })))
    await expect(api.get('/health', healthResponseSchema)).resolves.toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('reports a body that breaks the contract as a parse error', async () => {
    stubFetch(() => Promise.resolve(Response.json({ status: 'down' })))
    const error = await failure(api.get('/health', healthResponseSchema))
    expect(error.kind).toBe('parse')
  })

  it('uses the server error message on a non 2xx answer', async () => {
    stubFetch(() => Promise.resolve(Response.json({ error: 'not found' }, { status: 404 })))
    const error = await failure(api.get('/nope', healthResponseSchema))
    expect(error).toMatchObject({ kind: 'http', status: 404, message: 'not found' })
  })

  it('reads the code and message of the error shape', async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'validation_failed', message: 'Invalid query: limit: Too big' } },
          { status: 400 },
        ),
      ),
    )
    const error = await failure(api.get('/findings', healthResponseSchema))
    expect(error).toMatchObject({
      kind: 'http',
      status: 400,
      code: 'validation_failed',
      message: 'Invalid query: limit: Too big',
    })
  })

  it('keeps the status when an error page is not JSON', async () => {
    stubFetch(() => Promise.resolve(new Response('<h1>Bad gateway</h1>', { status: 502 })))
    const error = await failure(api.get('/health', healthResponseSchema))
    expect(error).toMatchObject({ kind: 'http', status: 502 })
  })

  it('wraps a failed request as a network error', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const error = await failure(api.get('/health', healthResponseSchema))
    expect(error.kind).toBe('network')
  })
})
