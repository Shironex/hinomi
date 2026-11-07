import type { DeploymentFacts, RuntimePinRecord } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import { readRuntimePins } from '../pins/index.js'
import type { Repositories } from '../repository/index.js'
import { runtimePinsDisagreeGuard, runtimeSupportGuard } from './guards/index.js'
import { RUNTIME_NOW, runtimeSupportIndex } from './guards/runtime-testing.js'
import { runScan } from './run.js'
import type { ScanPinsInput, ScanSources } from './sources.js'

// The scan reads each repo's runtime pins at its deployed branch, with the Dockerfile the
// deployment builds as production, and hands them to the runtime checks. Fictional kestrel-co.

let handle: DatabaseHandle
let repos: Repositories
let repoId: number

const FILES = {
  'apps/api/Dockerfile': 'FROM node:18-alpine\n',
  Dockerfile: 'FROM node:26-alpine\n',
}

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  const edge = repos.sources.create({
    kind: 'coolify',
    name: 'edge-1',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-fictional',
  })
  repoId = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-api' }).id
  repos.deployments.upsert({
    sourceId: edge.id,
    externalId: 'app-1',
    kind: 'application',
    name: 'kestrel-api',
    gitRepository: 'kestrel-co/kestrel-api',
    gitBranch: 'release',
    repoId,
    facts: {
      dockerfile: {
        location: '/Dockerfile',
        baseDirectory: '/apps/api',
        target: null,
        inline: null,
      },
    } as unknown as DeploymentFacts,
  })
})

afterEach(() => handle.close())

function sources(read: (input: ScanPinsInput) => Promise<RuntimePinRecord[]>) {
  const calls: ScanPinsInput[] = []
  const scanSources: ScanSources = {
    coolify: [],
    github: [],
    osv: null,
    settings: { osvEnabled: false, includeAccountRepos: false, imageScan: 'off' },
    fetchLockfiles: () => Promise.resolve([]),
    scanRuntimePins: async (input) => {
      calls.push(input)
      const pins = await read(input)
      repos.runtimePins.replace(input.repoId, input.ref, pins, input.now)
      return pins
    },
  }
  return { scanSources, calls }
}

const fromFiles = (input: ScanPinsInput) =>
  Promise.resolve(
    readRuntimePins(
      Object.entries(FILES).map(([path, text]) => ({ path, text })),
      input.productionDockerfiles ? { productionDockerfiles: input.productionDockerfiles } : {},
    ),
  )

const scan = (scanSources: ScanSources) =>
  runScan({ repositories: repos }, scanSources, {
    now: () => RUNTIME_NOW,
    guards: [runtimeSupportGuard, runtimePinsDisagreeGuard],
    support: () => runtimeSupportIndex(),
  })

const guardRow = (check: string) =>
  repos.findings.list({ repoId, kind: 'guard' }).find((f) => f.guardCheck === check)

describe('runtime pins in the scan', () => {
  it('reads at the deployed branch with the deployed Dockerfile as production', async () => {
    const { scanSources, calls } = sources(fromFiles)
    await scan(scanSources)
    expect(calls).toEqual([
      expect.objectContaining({
        repoId,
        owner: 'kestrel-co',
        name: 'kestrel-api',
        ref: 'release',
        sourceId: null,
        productionDockerfiles: new Set(['apps/api/Dockerfile']),
      }),
    ])
    expect(repos.runtimePins.list(repoId, 'release')).toHaveLength(2)
    expect(guardRow('runtime_support')).toMatchObject({ guardLevel: 'fail', state: 'open' })
    // The root Dockerfile is not deployed: it counts like a version file and disagrees.
    expect(guardRow('runtime_pins_disagree')).toMatchObject({ guardLevel: 'warn' })
  })

  it('keeps the last good pins when GitHub fails, and leaves the rows when there are none', async () => {
    const failing = sources(() => Promise.reject(new Error('GitHub said 502')))
    await scan(failing.scanSources)
    expect(guardRow('runtime_support')).toBeUndefined()

    await scan(sources(fromFiles).scanSources)
    await scan(failing.scanSources)
    const row = guardRow('runtime_support')!
    expect(row).toMatchObject({ guardLevel: 'fail', state: 'open' })
    expect(JSON.stringify(row.evidence)).toContain('GitHub said 502')
    expect(repos.runtimePins.list(repoId, 'release')).toHaveLength(2)
  })

  it('leaves the support finding alone without support data, but still compares pins', async () => {
    await runScan({ repositories: repos }, sources(fromFiles).scanSources, {
      now: () => RUNTIME_NOW,
      guards: [runtimeSupportGuard, runtimePinsDisagreeGuard],
    })
    expect(guardRow('runtime_support')).toBeUndefined()
    expect(guardRow('runtime_pins_disagree')).toMatchObject({ guardLevel: 'warn' })
  })
})
