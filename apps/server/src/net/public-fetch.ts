import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { directAgent } from './direct-agent.js'
import { isPublicAddress } from './public-address.js'
import { notPublicError, publicOnlyLookup } from './public-lookup.js'

// A small fetch for POSTs to a host a user named, that refuses to connect to anything but a
// public address. The check runs inside the connection's own DNS lookup (publicOnlyLookup), so a
// name cannot resolve to a public address for a check and to a private one for the request.
//
// node:http and node:https instead of the global fetch: fetch offers no hook into the address it
// connects to, and that hook is the whole point here. Redirects are never followed (a 3xx comes
// back as it is) and at most MAX_BODY_BYTES of the answer is read. A literal IP host never goes
// through a DNS lookup, so it is checked here; and requests never use a proxy from the
// environment (see direct-agent.ts), which would resolve the host instead of this lookup.

/** Bytes of the answer kept: enough for an error body or a retry_after. */
const MAX_BODY_BYTES = 64 * 1024

/** Statuses a Response cannot carry a body with. */
const NULL_BODY = new Set([101, 204, 205, 304])

function readBody(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    }
    response.on('data', (chunk: Buffer) => {
      if (size >= MAX_BODY_BYTES) return
      chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size))
      size += chunk.length
      if (size < MAX_BODY_BYTES) return
      response.destroy()
      done()
    })
    response.on('end', done)
    response.on('error', done)
    response.on('close', done)
  })
}

function headersOf(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  return headers
}

function plainHeaders(init: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(init).entries())
}

/**
 * Sends one request like fetch, but only to public addresses. Supports what the notification
 * delivery uses: method, headers, a string or bytes body and an abort signal. Rejects on network errors,
 * on a refused address and when the signal aborts.
 */
export const publicFetch = ((input: string | URL, init: RequestInit = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol ${url.protocol}`))
      return
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      reject(notPublicError(host))
      return
    }
    const body = typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : ''
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          ...plainHeaders(init.headers),
          ...(body.length > 0 && { 'content-length': String(Buffer.byteLength(body)) }),
        },
        lookup: publicOnlyLookup,
        agent: directAgent(url),
        ...(init.signal && { signal: init.signal }),
      },
      (response) => {
        void readBody(response).then((buffer) => {
          const status = response.statusCode ?? 502
          resolve(
            new Response(NULL_BODY.has(status) ? null : new Uint8Array(buffer), {
              status: status < 200 || status > 599 ? 502 : status,
              headers: headersOf(response),
            }),
          )
        })
      },
    )
    request.on('error', reject)
    request.end(body.length > 0 ? body : undefined)
  })) as typeof fetch
