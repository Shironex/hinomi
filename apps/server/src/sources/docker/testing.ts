import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DockerError } from './errors.js'
import type { DockerResponse, DockerTransport } from './transport.js'

// Test helpers for the Docker source: the recorded fixtures, an in-memory transport and a fake
// Docker daemon listening on a Unix socket (a named pipe on Windows). No real Docker anywhere.

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

/** A fixed answer, or a function of the path that gives the status and body. */
export type Route = unknown

/** The routes of the recorded fixtures, by path without the query. */
export function fixtureRoutes(): Record<string, Route> {
  const containers = fixture('containers') as { Id: string }[]
  const routes: Record<string, Route> = {
    '/_ping': 'OK',
    '/version': fixture('version'),
    '/containers/json': containers,
  }
  for (const c of containers) {
    if (!/^[0-9a-f]{64}$/.test(c.Id)) continue
    routes[`/containers/${c.Id}/json`] = fixture(`inspect-${c.Id.slice(0, 4)}`)
  }
  return routes
}

/** A transport over a route table, recording every request. A missing route answers 404. */
export function fakeTransport(routes: Record<string, Route>) {
  const calls: { method: string; path: string }[] = []
  const answer = (path: string): DockerResponse => {
    const route = routes[path.split('?')[0]!]
    if (route === undefined) return { status: 404, body: { message: 'no such route' } }
    return typeof route === 'function'
      ? (route as (p: string) => DockerResponse)(path)
      : { status: 200, body: structuredClone(route) }
  }
  const transport: DockerTransport = {
    async request(method, path) {
      calls.push({ method, path })
      return Promise.resolve(answer(path))
    },
    async get(path) {
      const { status, body } = await transport.request('GET', path)
      if (status >= 200 && status < 300) return body
      throw new DockerError(status === 404 ? 'not_found' : 'http_error', `status ${status}`, {
        status,
      })
    },
  }
  return { transport, calls }
}

export interface FakeDaemon {
  socketPath: string
  requests: { method: string; url: string }[]
  close(): Promise<void>
}

/** An HTTP server on a socket that answers like the Docker daemon from a route table. */
export async function startFakeDaemon(
  routes: Record<string, Route>,
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
): Promise<FakeDaemon> {
  const requests: { method: string; url: string }[] = []
  const dir =
    process.platform === 'win32' ? null : mkdtempSync(path.join(tmpdir(), 'hinomi-docker-'))
  const socketPath = dir
    ? path.join(dir, 'docker.sock')
    : `\\\\.\\pipe\\hinomi-docker-${process.pid}-${Math.random().toString(36).slice(2)}`
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    if (handler?.(req, res)) return
    const url = req.url ?? '/'
    const route = routes[url.split('?')[0]!]
    const reply = (status: number, body: unknown) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, {
        'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
      })
      res.end(text)
    }
    if (route === undefined) return reply(404, { message: 'page not found' })
    if (typeof route === 'function') {
      const { status, body } = (route as (p: string) => { status: number; body: unknown })(url)
      return reply(status, body)
    }
    reply(200, route)
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      }),
  }
}
