import { guardEvidenceSchema, type DockerSocketEvidence, type FactMount } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { baseFacts, contextOf, deployment } from './container-fixtures.js'
import { dockerSocketGuard } from './docker-socket.js'

const bind = (source: string | null, over: Partial<FactMount> = {}): FactMount => ({
  origin: 'run_options',
  type: 'bind',
  source,
  target: '/data',
  readOnly: false,
  service: null,
  ...over,
})

async function check(d: ReturnType<typeof deployment>) {
  const [result] = await dockerSocketGuard.run(contextOf([d]))
  if (!result || result.level === null) throw new Error('no result')
  expect(guardEvidenceSchema.safeParse(result.evidence).success).toBe(true)
  return { level: result.level, evidence: result.evidence as DockerSocketEvidence }
}

const withMounts = (mounts: FactMount[], over = {}) => deployment(baseFacts({ mounts, ...over }))

describe('docker_socket', () => {
  it('fails for a run option mount, read only too', async () => {
    const { level, evidence } = await check(
      withMounts([
        bind('/var/run/docker.sock', { target: '/var/run/docker.sock', readOnly: true }),
      ]),
    )
    expect(level).toBe('fail')
    expect(evidence.mounts).toEqual([
      {
        source: 'run_options',
        hostPath: '/var/run/docker.sock',
        containerPath: '/var/run/docker.sock',
        readOnly: true,
        service: null,
      },
    ])
    expect(evidence.checked).toContain('run_options')
  })

  it('fails for a compose volume of a service', async () => {
    const { level, evidence } = await check(
      withMounts([bind('/run/docker.sock', { origin: 'compose', service: 'agent' })]),
    )
    expect(level).toBe('fail')
    expect(evidence.mounts[0]).toMatchObject({ source: 'compose', service: 'agent' })
  })

  it('fails for a file storage and for the folders that hold the socket', async () => {
    expect(
      (await check(withMounts([bind('/var/run/docker.sock', { origin: 'file_storage' })]))).level,
    ).toBe('fail')
    expect((await check(withMounts([bind('/var/run')]))).level).toBe('fail')
    expect((await check(withMounts([bind('/run')]))).level).toBe('fail')
  })

  it('passes for lookalike paths, named volumes and other binds', async () => {
    for (const mount of [
      bind('/var/run/docker.sock.bak'),
      bind('/var/lib/app'),
      bind('docker', { type: 'volume' }),
      bind(null, { type: 'volume' }),
    ]) {
      const { level, evidence } = await check(withMounts([mount]))
      expect(level).toBe('pass')
      expect(evidence.mounts).toEqual([])
    }
  })

  it('passes with the gap text when some sources were not read', async () => {
    const gap = 'Coolify did not report the host path of persistent storages'
    const { level, evidence } = await check(
      withMounts([], { mountsChecked: ['run_options', 'file_storage'], gaps: { mounts: gap } }),
    )
    expect(level).toBe('pass')
    expect(evidence).toMatchObject({ checked: ['run_options', 'file_storage'], reason: gap })
  })

  it('is unknown when nothing was read or the facts are missing', async () => {
    const none = await check(
      withMounts([], {
        mountsChecked: [],
        gaps: { mounts: 'the compose file is too large to read' },
      }),
    )
    expect(none.level).toBe('unknown')
    expect(none.evidence.reason).toContain('too large')
    expect((await check(deployment(null))).level).toBe('unknown')
  })
})
