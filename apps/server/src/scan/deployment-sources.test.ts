import type { DeploymentRecord } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import type { ImageScanReader } from '../sources/deployments/index.js'
import { fakeDeploymentSource } from '../sources/deployments/testing.js'
import { runScan, skippedPhases, type ScanProgress } from './run.js'
import { buildScanSources, type DeploymentSource, type ScanSources } from './sources.js'

// The deployments phase reads a list of deployment sources through one interface. Two fictional
// instances: `edge` runs kestrel-co/harbor, `lab` runs kestrel-co/lantern and an image only app.

const AT = new Date('2026-11-15T06:00:00Z')

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  ;({ repos, handle } = createTestRepositories())
})
afterEach(() => handle.close())

function record(source: string, externalId: string, repo: string | null): DeploymentRecord {
  return {
    source,
    externalId,
    name: externalId,
    kind: 'application',
    repo,
    branch: repo ? 'main' : null,
    gitRepository: repo,
    domains: [`https://${externalId}.example.dev`],
    isPublic: true,
    server: 'edge-1',
    status: 'running:healthy',
    image: repo ? null : `ghcr.io/kestrel-co/${externalId}:1.0.0`,
    lastDeployAt: null,
    watchPaths: null,
  }
}

const row = (name: string) =>
  repos.sources.create({
    kind: 'coolify',
    name,
    baseUrl: `https://${name}.example.dev`,
    token: `${name}-token-fictional`,
  }).id

function sources(deployments: DeploymentSource[]): ScanSources {
  return {
    deployments,
    github: [],
    osv: null,
    fetchLockfiles: () => Promise.resolve([]),
    settings: { osvEnabled: false, includeAccountRepos: false, imageScan: 'off' },
  }
}

const scan = (list: DeploymentSource[], onProgress?: (p: ScanProgress) => void) =>
  runScan({ repositories: repos }, sources(list), {
    now: () => AT,
    guards: [],
    ...(onProgress && { onProgress }),
  })

const names = (sourceId: number) =>
  repos.deployments
    .listBySource(sourceId)
    .map((d) => d.externalId)
    .sort()

describe('the deployments phase over a list of sources', () => {
  it('stores the deployments of every source under its own row', async () => {
    const edge = row('edge')
    const lab = row('lab')
    const progress: ScanProgress[] = []
    const summary = await scan(
      [
        fakeDeploymentSource({
          sourceId: edge,
          name: 'edge',
          records: [record('edge', 'harbor', 'kestrel-co/harbor')],
        }),
        fakeDeploymentSource({
          sourceId: lab,
          name: 'lab',
          records: [record('lab', 'lantern', 'kestrel-co/lantern'), record('lab', 'docs', null)],
        }),
      ],
      (p) => progress.push(p),
    )

    expect(summary.status).toBe('succeeded')
    expect(names(edge)).toEqual(['harbor'])
    expect(names(lab)).toEqual(['docs', 'lantern'])
    expect(repos.repos.getByName('kestrel-co', 'lantern')).toBeDefined()
    expect(summary.sourceResults.coolify).toMatchObject({
      status: 'ok',
      counts: { attempted: 2, failed: 0, deployments: 3 },
    })
    expect(repos.sources.get(edge)?.lastOkAt).not.toBeNull()
    expect(repos.sources.get(lab)?.lastOkAt).not.toBeNull()
    // The scan opens on this phase (0 of 0), then counts one unit per source.
    expect(progress.filter((p) => p.phase === 'deployments').map((p) => [p.done, p.total])).toEqual(
      [
        [0, 0],
        [0, 2],
        [1, 2],
        [2, 2],
      ],
    )
  })

  it('records a failing source on its row and keeps its deployments, the others go on', async () => {
    const edge = row('edge')
    const lab = row('lab')
    const first = [
      fakeDeploymentSource({
        sourceId: edge,
        name: 'edge',
        records: [record('edge', 'harbor', 'kestrel-co/harbor')],
      }),
      fakeDeploymentSource({
        sourceId: lab,
        name: 'lab',
        records: [record('lab', 'lantern', 'kestrel-co/lantern')],
      }),
    ]
    await scan(first)

    const summary = await scan([
      fakeDeploymentSource({
        sourceId: edge,
        name: 'edge',
        records: () => Promise.reject(new Error('Could not reach the fictional instance')),
      }),
      fakeDeploymentSource({
        sourceId: lab,
        name: 'lab',
        records: [
          record('lab', 'lantern', 'kestrel-co/lantern'),
          record('lab', 'beacon', 'kestrel-co/beacon'),
        ],
      }),
    ])

    expect(summary.status).toBe('partial')
    expect(summary.errors).toEqual([
      { source: 'coolify', subject: 'edge', error: 'Could not reach the fictional instance' },
    ])
    expect(summary.sourceResults.coolify).toMatchObject({
      status: 'error',
      counts: { attempted: 2, failed: 1 },
    })
    expect(repos.sources.get(edge)?.lastError).toBe('Could not reach the fictional instance')
    expect(names(edge)).toEqual(['harbor'])
    expect(names(lab)).toEqual(['beacon', 'lantern'])
  })

  it('removes only the deployments the same source stopped reporting', async () => {
    const edge = row('edge')
    const lab = row('lab')
    await scan([
      fakeDeploymentSource({
        sourceId: edge,
        name: 'edge',
        records: [record('edge', 'harbor', 'kestrel-co/harbor')],
      }),
      fakeDeploymentSource({
        sourceId: lab,
        name: 'lab',
        records: [record('lab', 'harbor', 'kestrel-co/harbor')],
      }),
    ])
    // The same external id on two sources is two deployments.
    expect(repos.deployments.list()).toHaveLength(2)

    const summary = await scan([
      fakeDeploymentSource({ sourceId: edge, name: 'edge', records: [] }),
      fakeDeploymentSource({
        sourceId: lab,
        name: 'lab',
        records: [record('lab', 'harbor', 'kestrel-co/harbor')],
      }),
    ])
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ removed: 1 })
    expect(names(edge)).toEqual([])
    expect(names(lab)).toEqual(['harbor'])
  })

  it('skips the phase when no deployment source is connected', () => {
    expect(skippedPhases(sources([]))).toContain('deployments')
    const edge = row('edge')
    expect(
      skippedPhases(sources([fakeDeploymentSource({ sourceId: edge, name: 'edge', records: [] })])),
    ).not.toContain('deployments')
  })

  it('asks for image scan results only the sources that offer them', async () => {
    const edge = row('edge')
    const lab = row('lab')
    const probes: string[] = []
    const reader = (name: string): ImageScanReader => ({
      probe: () => {
        probes.push(name)
        return Promise.resolve({ status: 'unavailable', reason: 'no_endpoint' })
      },
      resource: () => Promise.reject(new Error('not asked')),
    })
    const summary = await runScan(
      { repositories: repos },
      {
        ...sources([
          fakeDeploymentSource({
            sourceId: edge,
            name: 'edge',
            records: [record('edge', 'site', null)],
          }),
          fakeDeploymentSource({
            sourceId: lab,
            name: 'lab',
            records: [record('lab', 'docs', null)],
            imageScan: reader('lab'),
          }),
        ]),
        settings: { osvEnabled: false, includeAccountRepos: false, imageScan: 'coolify' },
      },
      { now: () => AT, guards: [] },
    )
    expect(probes).toEqual(['lab'])
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ imageScanUnavailable: 1 })
  })
})

describe('buildScanSources', () => {
  it('opens every enabled deployment source with a token, lowest id first', () => {
    const edge = row('edge')
    const lab = row('lab')
    const off = row('off')
    repos.sources.update(off, { enabled: false })
    repos.sources.create({ kind: 'coolify', name: 'no-token', baseUrl: 'https://none.example.dev' })
    repos.sources.create({ kind: 'github', name: 'kestrel-co', token: 'gh-token-fictional' })

    const built = buildScanSources(repos)
    expect(built.deployments.map((s) => [s.sourceId, s.kind, s.name])).toEqual([
      [edge, 'coolify', 'edge'],
      [lab, 'coolify', 'lab'],
    ])
    expect(built.deployments.every((s) => s.capabilities.facts.has('user'))).toBe(true)
  })
})
