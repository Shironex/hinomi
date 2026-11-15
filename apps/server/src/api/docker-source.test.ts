import { sourceSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createTestApi } from './testing.js'

// Fictional PEM shapes, too short to be real material.
const CERT = '-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----'

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('docker sources', () => {
  it('stores a socket source with its settings and no token', async () => {
    const { call } = createTestApi()
    const created = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      docker: { transport: 'socket', socketPath: '/run/docker-proxy.sock' },
    })
    expect(created.status).toBe(201)
    expect(sourceSchema.parse(created.json)).toMatchObject({
      kind: 'docker',
      baseUrl: null,
      hasToken: false,
      docker: {
        transport: 'socket',
        socketPath: '/run/docker-proxy.sock',
        ca: null,
        cert: null,
        optIn: true,
      },
    })
  })

  it('refuses plain http, a token field and Docker settings on other kinds', async () => {
    const { call } = createTestApi()
    const http = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      baseUrl: 'http://192.0.2.4:2375',
      docker: { transport: 'tls' },
    })
    expect(http.status).toBe(400)
    expect(errorOf(http.json).message).toContain('Plain TCP without TLS is refused')
    const token = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      token: 'x',
      docker: { transport: 'socket', socketPath: '/var/run/docker.sock' },
    })
    expect(token.status).toBe(400)
    const missing = await call('POST', '/sources', { kind: 'docker', name: 'edge-1' })
    expect(missing.status).toBe(400)
    const elsewhere = await call('POST', '/sources', {
      kind: 'osv',
      name: 'osv',
      docker: { transport: 'socket', socketPath: '/var/run/docker.sock' },
    })
    expect(elsewhere.status).toBe(400)
    const relative = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      docker: { transport: 'socket', socketPath: 'docker.sock' },
    })
    expect(relative.status).toBe(400)
  })

  it('keeps the TLS client key encrypted and never sends it back', async () => {
    const { call, repos } = createTestApi()
    const noKey = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      baseUrl: 'https://192.0.2.4:2376',
      docker: { transport: 'tls', cert: CERT },
    })
    expect(noKey.status).toBe(400)
    const created = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      baseUrl: 'https://192.0.2.4:2376',
      docker: { transport: 'tls', ca: CERT, cert: CERT, key: KEY, optIn: false },
    })
    expect(created.status).toBe(201)
    expect(created.text).not.toContain('PRIVATE KEY')
    expect(created.json).toMatchObject({
      hasToken: true,
      docker: { transport: 'tls', cert: CERT, ca: CERT, optIn: false },
    })
    const id = (created.json as { id: number }).id
    expect(repos.sources.getToken(id)).toBe(KEY)

    // A new URL alone keeps the certificates and the key; switching to a socket drops the key.
    const moved = await call('PATCH', `/sources/${id}`, {
      baseUrl: 'https://192.0.2.5:2376',
      docker: { transport: 'tls' },
    })
    expect(moved.json).toMatchObject({ baseUrl: 'https://192.0.2.5:2376', hasToken: true })
    expect((moved.json as { docker: { cert: string } }).docker.cert).toBe(CERT)
    const socket = await call('PATCH', `/sources/${id}`, {
      baseUrl: null,
      docker: { transport: 'socket', socketPath: '/var/run/docker.sock' },
    })
    expect(socket.json).toMatchObject({ baseUrl: null, hasToken: false })
    expect(repos.sources.getToken(id)).toBeNull()
  })

  it('tests unsaved and saved settings through the Docker tester', async () => {
    const { call, testers } = createTestApi()
    testers.docker.mockResolvedValueOnce({
      ok: true,
      message: 'Connected to Docker 27.3.1, 2 containers',
      warning: 'This connection allows more than Hinomi needs',
    })
    const unsaved = await call('POST', '/sources/test', {
      kind: 'docker',
      docker: { transport: 'socket', socketPath: '/var/run/docker.sock' },
    })
    expect(unsaved.json).toMatchObject({
      ok: true,
      warning: 'This connection allows more than Hinomi needs',
    })
    expect(testers.docker).toHaveBeenCalledWith({
      config: {
        transport: 'socket',
        socketPath: '/var/run/docker.sock',
        ca: null,
        cert: null,
        optIn: true,
      },
      baseUrl: null,
      key: null,
    })

    const created = await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      baseUrl: 'https://192.0.2.4:2376',
      docker: { transport: 'tls', cert: CERT, key: KEY },
    })
    const id = (created.json as { id: number }).id
    const saved = await call('POST', `/sources/${id}/test`)
    expect(saved.status).toBe(200)
    expect(testers.docker).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://192.0.2.4:2376', key: KEY }),
    )
    expect(saved.text).not.toContain('PRIVATE KEY')
  })

  it('shows a socket source on the overview as not synced, never as missing a token', async () => {
    const { call } = createTestApi()
    await call('POST', '/sources', {
      kind: 'docker',
      name: 'edge-1',
      docker: { transport: 'socket', socketPath: '/var/run/docker.sock' },
    })
    const overview = (await call('GET', '/overview')).json as {
      sources: { kind: string; status: string }[]
    }
    expect(overview.sources.find((s) => s.kind === 'docker')?.status).toBe('never')
  })
})
