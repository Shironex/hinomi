import { describe, expect, it } from 'vitest'
import { isDockerSocketPath, mountsDockerSocket, parseVolumeSpec } from './docker-mount.js'
import { parseDockerRunOptions, parseMountOption } from './docker-run-options.js'

describe('parseDockerRunOptions user', () => {
  it.each([
    ['--user 1000:1000', '1000:1000'],
    ['--user=0', '0'],
    ['-u root', 'root'],
    ['-u1001', '1001'],
    ['--init --user "app:app" --rm', 'app:app'],
    ['--user 0 --user 1000', '1000'],
  ])('%s gives %s', (line, user) => {
    expect(parseDockerRunOptions(line).user).toBe(user)
  })

  it('is null without a user flag and does not read a user from other flags', () => {
    expect(parseDockerRunOptions('--init --userns host --label user=root').user).toBeNull()
    expect(parseDockerRunOptions('').user).toBeNull()
    expect(parseDockerRunOptions('--user').user).toBeNull()
  })
})

describe('parseDockerRunOptions mounts', () => {
  it('reads -v, --volume and the attached forms', () => {
    const { mounts } = parseDockerRunOptions(
      '-v /var/run/docker.sock:/var/run/docker.sock:ro --volume /var/lib/app:/data --volume=cache:/cache -v/srv/x:/x -v /scratch',
    )
    expect(mounts).toEqual([
      {
        type: 'bind',
        source: '/var/run/docker.sock',
        target: '/var/run/docker.sock',
        readOnly: true,
      },
      { type: 'bind', source: '/var/lib/app', target: '/data', readOnly: false },
      { type: 'volume', source: 'cache', target: '/cache', readOnly: false },
      { type: 'bind', source: '/srv/x', target: '/x', readOnly: false },
      { type: 'volume', source: null, target: '/scratch', readOnly: false },
    ])
  })

  it('reads --mount with the key aliases', () => {
    const { mounts } = parseDockerRunOptions(
      '--mount type=bind,source=/run/docker.sock,target=/sock --mount=type=bind,src=/a,dst=/b,readonly --mount "type=volume,source=data,destination=/d" --mount type=tmpfs,target=/t',
    )
    expect(mounts).toEqual([
      { type: 'bind', source: '/run/docker.sock', target: '/sock', readOnly: false },
      { type: 'bind', source: '/a', target: '/b', readOnly: true },
      { type: 'volume', source: 'data', target: '/d', readOnly: false },
      { type: 'tmpfs', source: null, target: '/t', readOnly: false },
    ])
  })

  it('handles a quoted csv field with a comma and readonly=false', () => {
    expect(parseMountOption('type=bind,"source=/odd,dir",target=/x,readonly=false')).toEqual({
      type: 'bind',
      source: '/odd,dir',
      target: '/x',
      readOnly: false,
    })
  })

  it('defaults an unspecified --mount type to volume and an unknown one to other', () => {
    expect(parseMountOption('source=a,target=/b').type).toBe('volume')
    expect(parseMountOption('type=npipe,source=a,target=/b').type).toBe('other')
  })
})

describe('parseDockerRunOptions networks and privileged', () => {
  it('collects --network and --net in order', () => {
    const options = parseDockerRunOptions(
      '--network shared-cache --net=host --network=edge-net --privileged',
    )
    expect(options.networks).toEqual(['shared-cache', 'host', 'edge-net'])
    expect(options.privileged).toBe(true)
  })

  it('is not privileged by default and ignores unknown flags', () => {
    const options = parseDockerRunOptions('--cap-add NET_ADMIN --network-alias web --memory 512m')
    expect(options).toEqual({ user: null, mounts: [], networks: [], privileged: false })
  })
})

describe('parseVolumeSpec', () => {
  it('classifies the source', () => {
    expect(parseVolumeSpec('./data:/data').type).toBe('bind')
    expect(parseVolumeSpec('../x:/x').type).toBe('bind')
    expect(parseVolumeSpec('~/x:/x').type).toBe('bind')
    expect(parseVolumeSpec('docker:/data').type).toBe('volume')
    expect(parseVolumeSpec('${DATA}:/data').type).toBe('other')
  })

  it('reads a comma mode list', () => {
    expect(parseVolumeSpec('/a:/b:ro,z').readOnly).toBe(true)
    expect(parseVolumeSpec('/a:/b:rw').readOnly).toBe(false)
  })
})

describe('docker socket paths', () => {
  it.each(['/var/run/docker.sock', '/run/docker.sock', '/var/run', '/run/', '/var/run//', '/'])(
    '%s exposes it',
    (p) => {
      expect(isDockerSocketPath(p)).toBe(true)
    },
  )

  it.each(['/var/run/docker.sock.bak', '/var/lib/app', '/run/docker', '/srv/var/run', 'docker'])(
    '%s does not',
    (p) => {
      expect(isDockerSocketPath(p)).toBe(false)
    },
  )

  it('only counts bind mounts', () => {
    expect(
      mountsDockerSocket([{ type: 'volume', source: '/run', target: '/x', readOnly: false }]),
    ).toBe(false)
    expect(
      mountsDockerSocket([{ type: 'bind', source: '/var/run', target: '/x', readOnly: true }]),
    ).toBe(true)
  })
})
