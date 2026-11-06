/** Test helpers: a scripted fetch that replays canned responses and records the requests. */

export interface CannedResponse {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

export interface RecordedRequest {
  url: string
  method: string
  body: unknown
  /** The authorization header sent, or null. */
  authorization: string | null
}

export function scriptedFetch(responses: (CannedResponse | Error)[]) {
  const requests: RecordedRequest[] = []
  const queue = [...responses]
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawBody = init?.body
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : null,
      authorization: new Headers(init?.headers).get('authorization'),
    })
    const next = queue.shift()
    if (next === undefined) return Promise.reject(new Error('no canned response left'))
    if (next instanceof Error) return Promise.reject(next)
    const status = next.status ?? 200
    const text = next.body === undefined ? '' : JSON.stringify(next.body)
    // 204 and 304 must not carry a body.
    return Promise.resolve(
      new Response(status === 204 ? null : text, { status, headers: next.headers }),
    )
  }
  return { fetch: impl, requests }
}
