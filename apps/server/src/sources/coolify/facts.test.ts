import { deploymentFactsSchema, mountsDockerSocket } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { buildCoolifyFacts, indexProjects, parseStorages, type CoolifyFactsInput } from './facts.js'

const fetchedAt = new Date('2026-11-07T10:00:00.000Z')
const SECRET = 'fictional-secret-7f3a'

const projects = indexProjects([
  {
    project: { id: 1, uuid: 'proj-shop', name: 'kestrel-shop' },
    environments: [{ id: 11, name: 'production', project_id: 1 }],
  },
  {
    project: { id: 2, uuid: 'proj-blog', name: 'kestrel-blog' },
    environments: [{ id: 21, name: 'production', project_id: 2 }],
  },
])

const noStorages = { file: [], persistent: [], persistentHostPathReported: false }

function facts(overrides: Partial<CoolifyFactsInput> & { raw: Record<string, unknown> }) {
  const result = buildCoolifyFacts({
    kind: 'application',
    storages: noStorages,
    projects,
    fetchedAt,
    ...overrides,
  })
  // Every result must satisfy the stored schema and never carry the secret.
  expect(deploymentFactsSchema.parse(result)).toEqual(result)
  expect(JSON.stringify(result)).not.toContain(SECRET)
  return result
}

const DOCKERFILE = [
  'FROM node:22-alpine AS build',
  'WORKDIR /app',
  `ENV API_TOKEN=${SECRET}`,
  'RUN npm ci',
  'FROM node:22-alpine',
  'COPY --from=build /app /app',
  'USER node',
  'CMD ["node", "server.js"]',
].join('\n')

describe('buildCoolifyFacts', () => {
  it('reads a dockerfile app with an inline Dockerfile, keeping only the parsed user', () => {
    const result = facts({
      raw: {
        uuid: 'app-api',
        build_pack: 'dockerfile',
        dockerfile: DOCKERFILE,
        dockerfile_location: '/Dockerfile',
        base_directory: '/apps/api',
        git_commit_sha: 'ABCDEF0123456789abcdef0123456789abcdef01',
        destination_id: 3,
        destination_type: 'App\\Models\\StandaloneDocker',
        server_id: 1,
        environment_id: 11,
        settings: { is_auto_deploy_enabled: true, connect_to_docker_network: false },
      },
    })
    expect(result).toMatchObject({
      buildPack: 'dockerfile',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      user: null,
      dockerfile: {
        location: '/Dockerfile',
        baseDirectory: '/apps/api',
        target: null,
        inline: {
          kind: 'non_root',
          user: 'node',
          line: 7,
          from: 'node:22-alpine',
          baseImage: 'node:22-alpine',
          baseNonroot: false,
        },
      },
      destination: { server: '1', typeName: 'App\\Models\\StandaloneDocker', id: 3 },
      attachedToDestination: true,
      project: { key: 'proj-shop', name: 'kestrel-shop', environment: 'production' },
      autoDeploy: true,
      gaps: {},
    })
  })

  it('reads the target stage and a base64 encoded inline Dockerfile', () => {
    const result = facts({
      raw: {
        build_pack: 'dockerfile',
        dockerfile: Buffer.from(DOCKERFILE).toString('base64'),
        dockerfile_target_build: 'build',
        environment_id: 11,
      },
    })
    expect(result.dockerfile?.inline).toMatchObject({ kind: 'none', stage: 'build', line: 1 })
  })

  it('keeps the repo Dockerfile location and no commit when Coolify has HEAD', () => {
    const result = facts({
      raw: {
        build_pack: 'dockerfile',
        dockerfile: null,
        dockerfile_location: '/Dockerfile.prod',
        git_commit_sha: 'HEAD',
        environment_id: 11,
      },
    })
    expect(result.commit).toBeNull()
    expect(result.dockerfile).toEqual({
      location: '/Dockerfile.prod',
      baseDirectory: null,
      target: null,
      inline: null,
    })
    expect(result.gaps.user).toBeUndefined()
  })

  it('parses run options without keeping environment values', () => {
    const result = facts({
      raw: {
        build_pack: 'nixpacks',
        custom_docker_run_options: `-u 0 -e DB_PASSWORD=${SECRET} -v /var/run/docker.sock:/var/run/docker.sock:ro --network shared-cache --privileged --network none`,
        environment_id: 21,
      },
    })
    expect(result.user).toBe('0')
    expect(result.privileged).toBe(true)
    expect(result.networks).toEqual([
      { origin: 'run_options', name: 'shared-cache', service: null },
    ])
    expect(result.mounts).toEqual([
      {
        origin: 'run_options',
        type: 'bind',
        source: '/var/run/docker.sock',
        target: '/var/run/docker.sock',
        readOnly: true,
        service: null,
      },
    ])
    expect(mountsDockerSocket(result.mounts)).toBe(true)
    expect(result.gaps.user).toBeUndefined()
  })

  it('says a nixpacks app without --user gives no user signal', () => {
    const result = facts({ raw: { build_pack: 'nixpacks', environment_id: 11 } })
    expect(result.gaps.user).toBe('this build pack does not say which user the container runs as')
    expect(result.services).toEqual([])
    expect(result.dockerfile).toBeNull()
  })

  it('notes the host network from run options', () => {
    const result = facts({ raw: { build_pack: 'static', custom_docker_run_options: '--net=host' } })
    expect(result.hostNetwork).toBe(true)
    expect(result.networks).toEqual([])
  })

  const COMPOSE = `
services:
  web:
    image: nginx:1.27
    environment:
      DB_PASSWORD: ${SECRET}
    volumes:
      - type: bind
        source: /run/docker.sock
        target: /sock
      - data:/srv
    networks: [default, shared]
  worker:
    build:
      context: .
      dockerfile: worker.Dockerfile
    user: "1000"
    privileged: true
    network_mode: host
networks:
  shared:
    external: true
    name: kestrel-shared
volumes:
  data: {}
`

  it('reads a compose app per service and drops the environment', () => {
    const result = facts({
      raw: {
        build_pack: 'dockercompose',
        docker_compose_raw: COMPOSE,
        docker_compose: `services:\n  web:\n    environment:\n      DB_PASSWORD: ${SECRET}\n`,
        environment_id: 11,
        settings: { connect_to_docker_network: false, is_auto_deploy_enabled: false },
      },
    })
    expect(result.services).toEqual([
      {
        name: 'web',
        user: null,
        image: 'nginx:1.27',
        build: null,
        privileged: false,
        networkMode: null,
      },
      {
        name: 'worker',
        user: '1000',
        image: null,
        build: { context: '.', dockerfile: 'worker.Dockerfile', target: null },
        privileged: true,
        networkMode: 'host',
      },
    ])
    expect(result.mounts.map((m) => [m.origin, m.type, m.source, m.service])).toEqual([
      ['compose', 'bind', '/run/docker.sock', 'web'],
      ['compose', 'volume', 'data', 'web'],
    ])
    expect(result.networks).toEqual([{ origin: 'compose', name: 'kestrel-shared', service: 'web' }])
    expect(result.hostNetwork).toBe(true)
    expect(result.privileged).toBe(true)
    expect(result.attachedToDestination).toBe(false)
    expect(result.autoDeploy).toBe(false)
    expect(result.mountsChecked).toEqual([
      'run_options',
      'compose',
      'file_storage',
      'persistent_storage',
    ])
  })

  it('reports an unreadable compose file without the excerpt that may hold secrets', () => {
    const result = facts({
      raw: {
        build_pack: 'dockercompose',
        docker_compose_raw: `services:\n  web:\n    image: x\n   bad: [${SECRET}\n`,
      },
    })
    expect(result.gaps.user).toMatch(/^the compose file could not be read/)
    expect(result.gaps.mounts).toBe(result.gaps.user)
    expect(result.services).toEqual([])
    expect(result.mountsChecked).not.toContain('compose')
  })

  it('keeps service and network names like __proto__ as plain data', () => {
    const result = facts({
      kind: 'service',
      raw: {
        docker_compose_raw:
          'services:\n  __proto__:\n    image: redis:7\n    networks: [constructor]\nnetworks:\n  constructor:\n    external: true\n',
        connect_to_docker_network: true,
      },
    })
    expect(result.services.map((s) => s.name)).toEqual(['__proto__'])
    expect(result.networks).toEqual([
      { origin: 'compose', name: 'constructor', service: '__proto__' },
    ])
    expect(({} as Record<string, unknown>).image).toBeUndefined()
  })

  it('reads a service as compose with its own network flag', () => {
    const result = facts({
      kind: 'service',
      raw: {
        docker_compose_raw: 'services:\n  app:\n    image: example/wiki:3.1\n',
        connect_to_docker_network: true,
        destination_id: 3,
        server_id: 2,
        environment_id: 21,
      },
    })
    expect(result).toMatchObject({
      buildPack: 'dockercompose',
      attachedToDestination: true,
      autoDeploy: null,
      project: { key: 'proj-blog' },
    })
    expect(result.gaps).toEqual({})
  })

  it('reads a database: image, attached to the destination, no user signal', () => {
    const result = facts({
      kind: 'database',
      raw: { image: 'postgres:17-alpine', destination_id: 3, environment_id: 11 },
    })
    expect(result).toMatchObject({ image: 'postgres:17-alpine', attachedToDestination: true })
    expect(result.gaps.user).toMatch(/managed database/)
  })

  it('lists gaps when settings, destination and project are missing', () => {
    const result = facts({
      raw: { build_pack: 'dockercompose', docker_compose_raw: 'services:\n  a:\n    image: x\n' },
      storages: null,
      projects: null,
    })
    expect(Object.keys(result.gaps).sort()).toEqual([
      'autoDeploy',
      'destination',
      'mounts',
      'networks',
      'project',
    ])
    expect(result.attachedToDestination).toBeNull()
    expect(result.mountsChecked).toEqual(['run_options', 'compose'])
  })

  it('reads the image of a registry image app', () => {
    const result = facts({
      raw: {
        build_pack: 'dockerimage',
        docker_registry_image_name: 'ghcr.io/kestrel-co/docs',
        docker_registry_image_tag: '1.4.2',
      },
    })
    expect(result.image).toBe('ghcr.io/kestrel-co/docs:1.4.2')
  })

  it('counts persistent storages only when Coolify reports their host path', () => {
    const withoutHostPath = facts({
      raw: { build_pack: 'nixpacks' },
      storages: parseStorages({
        persistent_storages: [{ name: 'kestrel-data', mount_path: '/data' }],
        file_storages: [{ fs_path: '/var/run/docker.sock', mount_path: '/sock', content: SECRET }],
      }),
    })
    expect(withoutHostPath.mountsChecked).toEqual(['run_options', 'file_storage'])
    expect(withoutHostPath.gaps.mounts).toMatch(/host path of persistent storages/)
    expect(mountsDockerSocket(withoutHostPath.mounts)).toBe(true)
    expect(withoutHostPath.mounts).toContainEqual({
      origin: 'persistent_storage',
      type: 'volume',
      source: 'kestrel-data',
      target: '/data',
      readOnly: false,
      service: null,
    })

    const withHostPath = facts({
      raw: { build_pack: 'nixpacks' },
      storages: parseStorages({
        persistent_storages: [
          { name: 'sock', mount_path: '/var/run/docker.sock', host_path: '/var/run/docker.sock' },
          { name: 'kestrel-data', mount_path: '/data', host_path: null },
        ],
        file_storages: [],
      }),
    })
    expect(withHostPath.mountsChecked).toContain('persistent_storage')
    expect(withHostPath.gaps.mounts).toBeUndefined()
    expect(mountsDockerSocket(withHostPath.mounts)).toBe(true)
  })
})

describe('parseStorages', () => {
  it('splits a bare list by fs_path and reads camel case host paths', () => {
    expect(
      parseStorages([
        { fs_path: '/srv/app/config.yml', mount_path: '/config.yml', is_directory: false },
        { name: 'cache', mount_path: '/cache', hostPath: '/srv/cache' },
      ]),
    ).toEqual({
      file: [{ hostPath: '/srv/app/config.yml', target: '/config.yml', isDirectory: false }],
      persistent: [{ name: 'cache', hostPath: '/srv/cache', target: '/cache' }],
      persistentHostPathReported: true,
    })
  })

  it('accepts a data wrapper and rejects other shapes', () => {
    expect(parseStorages({ data: [] })).toEqual({
      file: [],
      persistent: [],
      persistentHostPathReported: false,
    })
    expect(parseStorages({ message: 'nope' })).toBeNull()
    expect(parseStorages('text')).toBeNull()
  })
})

describe('indexProjects', () => {
  it('maps environment ids to projects with a null prototype safe Map', () => {
    const index = indexProjects([
      {
        project: { id: 5, name: '__proto__' },
        environments: [{ id: '__proto__', name: 'constructor' }, { id: 7 }, { name: 'no id' }],
      },
      { project: { name: 'no key' }, environments: [{ id: 8 }] },
    ])
    expect([...index.keys()]).toEqual(['__proto__', '7'])
    expect(index.get('7')).toEqual({ key: '5', name: '__proto__', environment: null })
    expect(({} as Record<string, unknown>).name).toBeUndefined()
  })
})
