import { afterEach, describe, expect, it } from 'vitest'
import { DockerError } from './errors.js'
import { startFakeDaemon, type FakeDaemon } from './testing.js'
import { createDockerTransport, tlsRequestOptions } from './transport.js'

let daemon: FakeDaemon | null = null
afterEach(async () => {
  await daemon?.close()
  daemon = null
})

const socket = (d: FakeDaemon) => ({ transport: 'socket' as const, socketPath: d.socketPath })

describe('docker transport over a socket', () => {
  it('reads JSON and text answers with GET', async () => {
    daemon = await startFakeDaemon({ '/version': { Version: '27.3.1' }, '/_ping': 'OK' })
    const transport = createDockerTransport(socket(daemon))
    expect(await transport.get('/version')).toEqual({ Version: '27.3.1' })
    expect(await transport.get('/_ping')).toBe('OK')
    expect(daemon.requests).toEqual([
      { method: 'GET', url: '/version' },
      { method: 'GET', url: '/_ping' },
    ])
  })

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'get'])(
    'refuses %s before anything reaches the daemon',
    async (method) => {
      daemon = await startFakeDaemon({ '/containers/json': [] })
      const transport = createDockerTransport(socket(daemon))
      await expect(transport.request(method, '/containers/json')).rejects.toMatchObject({
        code: 'method_not_allowed',
      })
      expect(daemon.requests).toEqual([])
    },
  )

  it('never sends anything but GET, whatever is asked', async () => {
    daemon = await startFakeDaemon({ '/containers/json': [] })
    const transport = createDockerTransport(socket(daemon))
    for (const method of ['POST', 'DELETE', 'GET']) {
      await transport.request(method, '/containers/json').catch(() => null)
    }
    expect(daemon.requests.map((r) => r.method)).toEqual(['GET'])
  })

  it.each(['containers/json', '//evil.example.com/x', '/a/../b', '/a b', 'http://x/'])(
    'refuses the path %s',
    async (path) => {
      daemon = await startFakeDaemon({})
      const transport = createDockerTransport(socket(daemon))
      await expect(transport.get(path)).rejects.toMatchObject({ code: 'bad_request' })
      expect(daemon.requests).toEqual([])
    },
  )

  it('maps statuses to errors without echoing the daemon message', async () => {
    daemon = await startFakeDaemon({
      '/info': () => ({ status: 403, body: { message: 'secret detail' } }),
      '/boom': () => ({ status: 500, body: { message: 'secret detail' } }),
      '/moved': () => ({ status: 302, body: '' }),
    })
    const transport = createDockerTransport(socket(daemon))
    const forbidden = await transport.get('/info').catch((e: unknown) => e)
    expect(forbidden).toBeInstanceOf(DockerError)
    expect(forbidden).toMatchObject({ code: 'forbidden', status: 403 })
    expect((forbidden as Error).message).not.toContain('secret detail')
    await expect(transport.get('/boom')).rejects.toMatchObject({ code: 'server_error' })
    await expect(transport.get('/nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(transport.get('/moved')).rejects.toMatchObject({ code: 'http_error' })
  })

  it('does not follow a redirect', async () => {
    daemon = await startFakeDaemon({}, (req, res) => {
      if (req.url === '/hop') {
        res.writeHead(301, { location: '/target' })
        res.end()
        return true
      }
      return false
    })
    const transport = createDockerTransport(socket(daemon))
    await expect(transport.get('/hop')).rejects.toMatchObject({ code: 'http_error' })
    expect(daemon.requests.map((r) => r.url)).toEqual(['/hop'])
  })

  it('caps the size of an answer, with and without a content length', async () => {
    const big = 'x'.repeat(5000)
    daemon = await startFakeDaemon({ '/big': big }, (req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('['.padEnd(3000, ' '))
        res.end(' '.repeat(3000) + ']')
        return true
      }
      return false
    })
    const transport = createDockerTransport(socket(daemon), { maxBytes: 4000 })
    await expect(transport.get('/big')).rejects.toMatchObject({ code: 'too_large' })
    await expect(transport.get('/stream')).rejects.toMatchObject({ code: 'too_large' })
  })

  it('times out a daemon that does not answer', async () => {
    daemon = await startFakeDaemon({}, () => true)
    const transport = createDockerTransport(socket(daemon), { timeoutMs: 50 })
    await expect(transport.get('/containers/json')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('says when the socket is missing', async () => {
    const transport = createDockerTransport({
      transport: 'socket',
      socketPath:
        process.platform === 'win32' ? '\\\\.\\pipe\\hinomi-none' : '/nonexistent/docker.sock',
    })
    await expect(transport.get('/_ping')).rejects.toMatchObject({ code: 'network' })
  })
})

describe('docker transport over TLS', () => {
  it('refuses plain http before connecting', async () => {
    const transport = createDockerTransport({ transport: 'tls', url: 'http://192.0.2.4:2375' })
    await expect(transport.get('/_ping')).rejects.toMatchObject({ code: 'insecure' })
  })

  it('verifies the server and sends the client certificate', () => {
    const options = tlsRequestOptions(
      {
        transport: 'tls',
        url: 'https://docker.example.com:2376/',
        ca: 'CA',
        cert: 'CERT',
        key: 'KEY',
      },
      '/containers/json',
    )
    expect(options).toMatchObject({
      protocol: 'https:',
      hostname: 'docker.example.com',
      port: '2376',
      path: '/containers/json',
      method: 'GET',
      rejectUnauthorized: true,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
    })
  })

  it('keeps a path prefix of the endpoint', () => {
    const options = tlsRequestOptions(
      { transport: 'tls', url: 'https://proxy.example.com/docker' },
      '/version',
    )
    expect(options).toMatchObject({ path: '/docker/version', port: 443 })
    expect(options).not.toHaveProperty('key')
  })
})
