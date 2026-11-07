import { repoDetailSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { readRuntimePins } from '../pins/index.js'
import { runtimeSupportIndex } from '../scan/guards/runtime-testing.js'
import { createTestApi } from './testing.js'

// GET /api/repos/:id serves the repo's runtime pins and support lines for the runtime panel.
// Fictional kestrel-co data.

const AT = new Date('2026-11-07T06:00:00Z')

function world(withSupport: boolean) {
  const api = createTestApi({
    support: {
      status: () => {
        throw new Error('not asked here')
      },
      index: () => (withSupport ? runtimeSupportIndex() : null),
    },
  })
  const { repos } = api
  const edge = repos.sources.create({
    kind: 'coolify',
    name: 'edge-1',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-fictional',
  })
  const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-api' })
  repos.deployments.upsert({
    sourceId: edge.id,
    externalId: 'app-1',
    kind: 'application',
    name: 'kestrel-api',
    gitRepository: 'kestrel-co/kestrel-api',
    gitBranch: 'release',
    repoId: repo.id,
  })
  const pins = readRuntimePins([
    { path: 'Dockerfile', text: 'FROM node:18-alpine\n' },
    { path: '.nvmrc', text: '26\n' },
  ])
  repos.runtimePins.replace(repo.id, 'release', pins, AT)
  // Pins of another ref are not the ones the scan reads.
  repos.runtimePins.replace(repo.id, 'main', pins.slice(1), AT)
  return { ...api, repo }
}

describe('GET /api/repos/:id runtime data', () => {
  it('lists the pins of the scanned branch, marks the disagreeing ones and judges each runtime', async () => {
    const { call, repo } = world(true)
    const detail = repoDetailSchema.parse((await call('GET', `/repos/${repo.id}`)).json)
    expect(detail.runtimePins.map((p) => [p.path, p.raw, p.ref, p.scope, p.disagrees])).toEqual([
      ['.nvmrc', '26', 'release', 'dev', true],
      ['Dockerfile', 'node:18-alpine', 'release', 'production', false],
    ])
    expect(detail.runtimePins[0]!.scannedAt).toBe(AT.toISOString())
    expect(detail.supportLines.available).toBe(true)
    expect(detail.supportLines.runtimes).toHaveLength(1)
    expect(detail.supportLines.runtimes[0]).toMatchObject({
      runtime: 'node',
      result: 'fail',
      support: { line: '18', isEol: true },
      target: { line: '26', latest: '26.2.0' },
      fixHints: [{ path: 'Dockerfile', from: 'node:18-alpine', to: 'node:26-alpine' }],
    })
  })

  it('says when there is no support data yet', async () => {
    const { call, repo } = world(false)
    const detail = repoDetailSchema.parse((await call('GET', `/repos/${repo.id}`)).json)
    expect(detail.runtimePins).toHaveLength(2)
    expect(detail.supportLines).toEqual({ available: false, runtimes: [] })
  })
})
