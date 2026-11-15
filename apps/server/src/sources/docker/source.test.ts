import { afterEach, describe, expect, it } from 'vitest'
import { openDeploymentSource } from '../deployments/registry.js'
import { dockerEndpointOf } from './source.js'
import { fixtureRoutes, startFakeDaemon, type FakeDaemon } from './testing.js'

let daemon: FakeDaemon | null = null
afterEach(async () => {
  await daemon?.close()
  daemon = null
})

const noToken = { getToken: () => null }

describe('docker deployment source', () => {
  it('reads a fake daemon over its socket through the registry, GET only', async () => {
    daemon = await startFakeDaemon(fixtureRoutes())
    const source = openDeploymentSource(
      {
        id: 7,
        kind: 'docker',
        name: 'edge-1',
        baseUrl: null,
        config: {
          transport: 'socket',
          socketPath: daemon.socketPath,
          ca: null,
          cert: null,
          optIn: true,
        },
      },
      noToken,
    )
    expect(source).toMatchObject({ kind: 'docker', sourceId: 7, name: 'edge-1' })
    expect(source!.capabilities.guards).toEqual({
      root_user: 'full',
      docker_socket: 'full',
      shared_network: 'full',
    })
    expect(source!.deployHistory).toBeUndefined()
    const records = await source!.inventory()
    expect(records.length).toBeGreaterThanOrEqual(3)
    expect(daemon.requests.length).toBeGreaterThan(1)
    expect(daemon.requests.every((r) => r.method === 'GET')).toBe(true)
  })

  it('fails the read, not the scan, without connection settings', async () => {
    const source = openDeploymentSource(
      { id: 8, kind: 'docker', name: 'edge-2', baseUrl: null, config: null },
      noToken,
    )
    await expect(source!.inventory()).rejects.toThrow('no connection settings')
  })
})

describe('dockerEndpointOf', () => {
  const tls = { transport: 'tls' as const, socketPath: null, ca: null, cert: null, optIn: true }

  it('refuses plain http', () => {
    expect(() => dockerEndpointOf(tls, 'http://192.0.2.4:2375', () => null)).toThrow(
      'Plain TCP without TLS is refused',
    )
  })

  it('reads the client key only when a client certificate is set', () => {
    let reads = 0
    const key = () => {
      reads++
      return 'KEY'
    }
    expect(dockerEndpointOf(tls, 'https://192.0.2.4:2376', key)).toMatchObject({ key: null })
    expect(reads).toBe(0)
    expect(dockerEndpointOf({ ...tls, cert: 'CERT' }, 'https://192.0.2.4:2376', key)).toMatchObject(
      { cert: 'CERT', key: 'KEY' },
    )
    expect(reads).toBe(1)
  })
})
