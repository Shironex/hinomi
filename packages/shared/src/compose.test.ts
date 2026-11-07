import { describe, expect, it } from 'vitest'
import { externalNetworkNames, parseCompose, type ComposeFile } from './compose.js'
import { mountsDockerSocket } from './docker-mount.js'

function read(text: string, env?: Record<string, string>): ComposeFile {
  const result = parseCompose(text, { env })
  if (!result.ok) throw new Error(result.error)
  return result.file
}

const KESTREL = `
name: kestrel-shop
services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    networks: [front]
  worker:
    build:
      context: ./worker
      dockerfile: Dockerfile.worker
      target: prod
    user: "1000"
    volumes:
      - ./data:/data:ro
      - cache:/cache
      - /scratch
  agent:
    image: registry.example.dev/ops/agent:2.1
    user: 0:0
    privileged: true
    volumes:
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
        read_only: true
      - type: volume
        source: state
        target: /state
    networks:
      front:
        aliases: [agent]
      shared-cache:
networks:
  front:
  shared-cache:
    external: true
  legacy:
    name: kestrel-legacy-net
    external: true
  renamed:
    external:
      name: kestrel-bridge
volumes:
  cache:
  state:
`

describe('parseCompose', () => {
  const file = read(KESTREL)

  it('reads services in order with image and build', () => {
    expect(file.services.map((s) => s.name)).toEqual(['web', 'worker', 'agent'])
    expect(file.services[0]?.imageRef).toMatchObject({ repository: 'nginx', tag: '1.27' })
    expect(file.services[1]?.build).toEqual({
      context: './worker',
      dockerfile: 'Dockerfile.worker',
      target: 'prod',
    })
    expect(file.services[2]?.imageRef).toMatchObject({
      registry: 'registry.example.dev',
      repository: 'ops/agent',
    })
  })

  it('reads the user of each service', () => {
    const [web, worker, agent] = file.services
    expect(web).toMatchObject({ user: null, userKind: null })
    expect(worker).toMatchObject({ user: '1000', userKind: 'non_root' })
    expect(agent).toMatchObject({ user: '0:0', userKind: 'root', privileged: true })
  })

  it('stringifies a numeric user', () => {
    const { services } = read(
      'services:\n  a:\n    image: x\n    user: 0\n  b:\n    image: x\n    user: 1000\n',
    )
    expect(services.map((s) => [s.user, s.userKind])).toEqual([
      ['0', 'root'],
      ['1000', 'non_root'],
    ])
  })

  it('reads short and long volumes', () => {
    const [, worker, agent] = file.services
    expect(worker?.volumes).toEqual([
      { type: 'bind', source: './data', target: '/data', readOnly: true },
      { type: 'volume', source: 'cache', target: '/cache', readOnly: false },
      { type: 'volume', source: null, target: '/scratch', readOnly: false },
    ])
    expect(agent?.volumes[0]).toEqual({
      type: 'bind',
      source: '/var/run/docker.sock',
      target: '/var/run/docker.sock',
      readOnly: true,
    })
    expect(mountsDockerSocket(agent?.volumes ?? [])).toBe(true)
    expect(mountsDockerSocket(worker?.volumes ?? [])).toBe(false)
  })

  it('reads service networks from a list, a map and the default', () => {
    expect(file.services.map((s) => s.networks)).toEqual([
      ['front'],
      ['default'],
      ['front', 'shared-cache'],
    ])
  })

  it('reads top level networks and their real names', () => {
    expect(file.networks).toEqual([
      { key: 'front', name: 'front', external: false },
      { key: 'shared-cache', name: 'shared-cache', external: true },
      { key: 'legacy', name: 'kestrel-legacy-net', external: true },
      { key: 'renamed', name: 'kestrel-bridge', external: true },
    ])
  })

  it('lists the external networks a service joins', () => {
    const [web, , agent] = file.services
    expect(externalNetworkNames(file, web!)).toEqual([])
    expect(externalNetworkNames(file, agent!)).toEqual(['shared-cache'])
  })

  it('reads network_mode', () => {
    const { services } = read('services:\n  a:\n    image: x\n    network_mode: host\n')
    expect(services[0]?.networkMode).toBe('host')
  })
})

describe('parseCompose interpolation', () => {
  it('resolves defaults and given env in image, user and volume sources', () => {
    const { services } = read(
      [
        'services:',
        '  a:',
        '    image: node:${NODE_TAG:-22-alpine}',
        '    user: ${RUN_AS}',
        '    volumes:',
        '      - ${SOCK:-/var/run/docker.sock}:/var/run/docker.sock',
        '      - ${DATA_DIR}:/data',
      ].join('\n'),
      { RUN_AS: '0' },
    )
    const service = services[0]
    expect(service?.imageRef?.tag).toBe('22-alpine')
    expect(service).toMatchObject({ user: '0', userKind: 'root' })
    expect(mountsDockerSocket(service?.volumes ?? [])).toBe(true)
    expect(service?.volumes[1]).toMatchObject({ type: 'other', source: '${DATA_DIR}' })
  })

  it('leaves an unresolved user as unknown', () => {
    const { services } = read('services:\n  a:\n    image: x\n    user: ${RUN_AS}\n')
    expect(services[0]).toMatchObject({ user: '${RUN_AS}', userKind: null })
  })

  it('keeps an escaped dollar', () => {
    const { services } = read('services:\n  a:\n    image: x\n    volumes:\n      - $$HOME/x:/x\n')
    expect(services[0]?.volumes[0]?.source).toBe('$HOME/x')
  })
})

describe('parseCompose failures', () => {
  it('reports invalid YAML', () => {
    const result = parseCompose('services:\n  a: [unclosed\n')
    expect(result.ok).toBe(false)
  })

  it('reports a file without services', () => {
    expect(parseCompose('version: "3"\n')).toEqual({
      ok: false,
      error: 'the file has no services map',
    })
    expect(parseCompose('')).toMatchObject({ ok: false })
    expect(parseCompose('- a\n- b\n')).toMatchObject({ ok: false })
  })

  it('skips a service that is not a map and tolerates odd field types', () => {
    const { services } = read(
      'services:\n  a: null\n  b:\n    image: [x]\n    volumes: nope\n    user: [1]\n',
    )
    expect(services.map((s) => s.name)).toEqual(['b'])
    expect(services[0]).toMatchObject({ image: null, user: null, volumes: [] })
  })
})
