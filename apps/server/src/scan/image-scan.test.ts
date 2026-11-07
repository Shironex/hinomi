import { readFileSync } from 'node:fs'
import type { DeploymentRecord } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import {
  coverageNoteFindingKey,
  coverageNoteTypeOf,
  imageAdvisoryFindingKey,
  type Repositories,
} from '../repository/index.js'
import {
  createCoolifyClient,
  fetchResourceScan,
  type ImageScanProbe,
  type ResourceScanResult,
} from '../sources/coolify/index.js'
import { applyCoverageNotes } from './blind-spots.js'
import { indexDeployments } from './deployments.js'
import { runImageScan } from './image-scan.js'
import { tierOf } from './rank.js'
import { runScan } from './run.js'
import { SCAN_SETTING_KEYS } from './settings.js'
import { buildScanSources } from './sources.js'
import type { ImageScanReader, ScanSources } from './sources.js'
import { reopenFinding } from './state.js'
import { listRankedFindings } from './views.js'

// A fictional world: one Coolify instance runs static-docs, an image only app on edge-1 (public),
// and harbor-web, built from kestrel-co/harbor. Coolify's scan of static-docs has two findings
// (one in the CISA KEV list, one ignored in Coolify) and one image whose list was capped.

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../sources/coolify/fixtures/vulnerabilities.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Parses a response body the way the real reader does. */
async function scanOf(body: unknown): Promise<ResourceScanResult> {
  const client = createCoolifyClient({
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
    fetch: () => Promise.resolve(json(body)),
  })
  return fetchResourceScan(client, 'application', 'app-docs')
}

interface FakeReader extends ImageScanReader {
  reads: string[]
}

function fakeReader(
  probe: ImageScanProbe | (() => Promise<ImageScanProbe>),
  resource: (externalId: string) => Promise<ResourceScanResult>,
): FakeReader {
  const reads: string[] = []
  return {
    reads,
    probe: typeof probe === 'function' ? probe : () => Promise.resolve(probe),
    resource: (_kind, externalId) => {
      reads.push(externalId)
      return resource(externalId)
    },
  }
}

const available = (checkedAt: string | null = '2026-11-07T08:00:00+00:00'): ImageScanProbe => ({
  status: 'available',
  checkedAt: new Map([['app-docs', checkedAt]]),
})

let handle: DatabaseHandle
let repos: Repositories
let clock: Date
let sourceId: number

function record(overrides: Partial<DeploymentRecord>): DeploymentRecord {
  return {
    source: 'main',
    externalId: 'app-docs',
    name: 'static-docs',
    kind: 'application',
    repo: null,
    branch: null,
    gitRepository: null,
    domains: ['https://docs.example.dev'],
    isPublic: true,
    server: 'edge-1',
    status: 'running:healthy',
    image: 'ghcr.io/kestrel-co/static-docs:1.4.0',
    lastDeployAt: null,
    watchPaths: null,
    ...overrides,
  }
}

const RECORDS = [
  record({}),
  record({
    externalId: 'app-harbor',
    name: 'harbor-web',
    repo: 'kestrel-co/harbor',
    gitRepository: 'kestrel-co/harbor',
    domains: ['https://harbor.example.dev'],
  }),
]

function sources(mode: 'off' | 'coolify', reader?: ImageScanReader): ScanSources {
  return {
    coolify: [
      {
        sourceId,
        name: 'main',
        fetchInventory: () => Promise.resolve(RECORDS),
        ...(reader && { imageScan: reader }),
      },
    ],
    github: [],
    osv: null,
    fetchLockfiles: () => Promise.resolve([]),
    settings: { osvEnabled: false, includeAccountRepos: false, imageScan: mode },
  }
}

const scan = (mode: 'off' | 'coolify', reader?: ImageScanReader) =>
  runScan({ repositories: repos }, sources(mode, reader), { now: () => clock })

const docs = () => repos.deployments.list().find((d) => d.name === 'static-docs')!
const note = (type: 'image_only' | 'image_scan_partial') =>
  repos.findings.getByKey(coverageNoteFindingKey(type, docs().id))
const imageFindings = () =>
  repos.findings.list({ deploymentId: docs().id, kind: 'advisory' }).map((f) => ({
    ...f,
    advisory: repos.advisories.get(f.advisoryId!)!,
  }))
const byPackage = (name: string) => imageFindings().find((f) => f.advisory.packageName === name)!

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  clock = new Date('2026-11-08T10:00:00Z')
  sourceId = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  }).id
})

afterEach(() => handle.close())

describe('image scan from Coolify results', () => {
  it('is off by default: the coverage note stays and Coolify is not asked', async () => {
    const reader = fakeReader(available(), () => scanOf(FIXTURE))
    const summary = await scan('off', reader)
    expect(summary.status).toBe('succeeded')
    expect(reader.reads).toEqual([])
    expect(note('image_only')).toMatchObject({ state: 'open' })
    expect(imageFindings()).toEqual([])
  })

  it('turns the coverage note into advisory findings when the setting is on', async () => {
    await scan('off')
    const reader = fakeReader(available(), () => scanOf(FIXTURE))
    const summary = await scan('coolify', reader)

    // Only the image only deployment is read; harbor-web has a repo.
    expect(reader.reads).toEqual(['app-docs'])
    expect(summary.status).toBe('succeeded')
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ imagesScanned: 1 })

    const render = byPackage('example-render')
    expect(render).toMatchObject({
      kind: 'advisory',
      state: 'open',
      dedupeKey: imageAdvisoryFindingKey(render.advisoryId!, docs().id),
      repoId: null,
      deploymentId: docs().id,
      reportedBy: ['image'],
      scope: 'runtime',
      installedVersion: '2.1.0',
      evidence: {
        imageScan: 'coolify',
        imageRefs: ['ghcr.io/kestrel-co/static-docs:1.4.0'],
        scannedAt: '2026-11-07T07:55:00.000Z',
        kev: true,
        epss: 0.41,
        risk: 92.5,
        fixState: 'fixed',
        packageType: 'npm',
      },
    })
    expect(render.advisory).toMatchObject({
      advisoryKey: 'GHSA-x4mq-7p2v-c9hw',
      ghsaId: 'GHSA-x4mq-7p2v-c9hw',
      cveIds: ['CVE-2026-1001'],
      ecosystem: 'npm',
      severity: 'critical',
      cvssScore: 9.8,
      firstPatchedVersion: '2.1.4',
    })

    // Ignored in Coolify: accepted with the reason, by the system.
    const lib = byPackage('libexample1')
    expect(lib).toMatchObject({ state: 'accepted', stateReason: 'ignored in Coolify' })
    expect(lib.advisory).toMatchObject({
      advisoryKey: 'CVE-2026-2002',
      ecosystem: 'deb',
      severity: 'moderate',
      url: null,
    })
    expect(repos.findings.listEvents(lib.id)[0]).toMatchObject({
      toState: 'accepted',
      actor: 'system',
    })

    // The image only note resolves as covered; the capped image gets its own note.
    expect(note('image_only')).toMatchObject({ state: 'fixed' })
    const resolved = repos.findings.listEvents(note('image_only')!.id)[0]!
    expect(resolved).toMatchObject({
      type: 'resolved',
      data: { coveredBy: 'image_scan', mode: 'coolify' },
    })
    expect(note('image_scan_partial')).toMatchObject({ state: 'open' })
    const events = repos.findings.listEvents(note('image_scan_partial')!.id)
    expect(events.find((e) => e.type === 'details')).toMatchObject({
      data: { truncatedImages: ['ghcr.io/kestrel-co/static-docs-sidecar:2.0.1'] },
    })
    expect(docs().imageScannedAt).toEqual(new Date('2026-11-07T07:55:00Z'))

    // Ranked like a lockfile advisory on a public deployment.
    const ranked = listRankedFindings(repos).find((r) => r.finding.id === render.id)!
    expect(tierOf(ranked)).toBe('exposed')
    expect(ranked.deployments.map((d) => d.name)).toEqual(['static-docs'])
  })

  it('joins an advisory another source already stored by its CVE or GHSA alias', async () => {
    const existing = repos.advisories.upsert({
      advisoryKey: 'GHSA-x4mq-7p2v-c9hw',
      ghsaId: 'GHSA-x4mq-7p2v-c9hw',
      cveIds: ['CVE-2026-1001'],
      aliases: [],
      ecosystem: 'npm',
      packageName: 'example-render',
      severity: 'high',
      summary: 'From GitHub',
      vulnerableRanges: ['< 2.1.4'],
    })
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    const render = byPackage('example-render')
    expect(render.advisoryId).toBe(existing.id)
    // GitHub stays authoritative for what it already said.
    expect(render.advisory).toMatchObject({ severity: 'high', summary: 'From GitHub' })
  })

  it('does not refetch an image Coolify has not scanned again', async () => {
    await scan('off')
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    clock = new Date('2026-11-08T16:00:00Z')
    // checked_at is not newer than the stored scan time: nothing to read.
    const reader = fakeReader(available('2026-11-07T07:55:00+00:00'), () => scanOf(FIXTURE))
    const summary = await scan('coolify', reader)
    expect(reader.reads).toEqual([])
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ imagesUnchanged: 1 })
    expect(note('image_only')).toMatchObject({ state: 'fixed' })
    expect(byPackage('example-render')).toMatchObject({ state: 'open' })

    // A newer marker reads again.
    const again = fakeReader(available('2026-11-08T12:00:00+00:00'), () => scanOf(FIXTURE))
    await scan('coolify', again)
    expect(again.reads).toEqual(['app-docs'])
  })

  it('fixes what a complete result no longer lists, and only then', async () => {
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    const findings = FIXTURE.findings as Record<string, unknown>[]
    const images = FIXTURE.images as Record<string, unknown>[]

    // Partial (an image is still truncated): the missing finding stays open.
    const partial = { ...FIXTURE, findings: [findings[1]], pagination: { total: 1 } }
    await scan(
      'coolify',
      fakeReader(available(null), () => scanOf(partial)),
    )
    expect(byPackage('example-render')).toMatchObject({ state: 'open' })

    // Complete: it is fixed and the partial note resolves.
    const complete = {
      ...partial,
      images: images.map((i) => ({ ...i, truncated: false })),
    }
    await scan(
      'coolify',
      fakeReader(available(null), () => scanOf(complete)),
    )
    expect(byPackage('example-render')).toMatchObject({ state: 'fixed' })
    expect(note('image_scan_partial')).toMatchObject({ state: 'fixed' })

    // It comes back: reopened.
    await scan(
      'coolify',
      fakeReader(available(null), () => scanOf(FIXTURE)),
    )
    expect(byPackage('example-render')).toMatchObject({ state: 'open' })
  })

  it('accepts an ignored finding on first sight only; a later Hinomi decision wins', async () => {
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    const lib = byPackage('libexample1')
    reopenFinding(repos.findings, lib.id, { reason: 'we want to track it', now: clock })
    await scan(
      'coolify',
      fakeReader(available(null), () => scanOf(FIXTURE)),
    )
    expect(byPackage('libexample1')).toMatchObject({ state: 'open' })
  })

  it('keeps the note on a Coolify without the endpoint, without an error', async () => {
    const reader = fakeReader({ status: 'unavailable', reason: 'no_endpoint' }, () =>
      scanOf(FIXTURE),
    )
    const summary = await scan('coolify', reader)
    expect(summary.status).toBe('succeeded')
    expect(summary.errors).toEqual([])
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ imageScanUnavailable: 1 })
    expect(reader.reads).toEqual([])
    expect(note('image_only')).toMatchObject({ state: 'open' })
  })

  it('reports a token without permission once, and keeps the note', async () => {
    const summary = await scan(
      'coolify',
      fakeReader({ status: 'forbidden', message: 'The Coolify token may not read (403)' }, () =>
        scanOf(FIXTURE),
      ),
    )
    expect(summary.status).toBe('failed')
    expect(summary.errors).toEqual([
      { source: 'coolify', subject: 'main', error: 'The Coolify token may not read (403)' },
    ])
    expect(repos.sources.get(sourceId)?.lastError).toMatch(/403/)
    expect(note('image_only')).toMatchObject({ state: 'open' })
  })

  it('leaves the note and findings alone when Coolify fails for a while', async () => {
    await scan('off')
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    const down = fakeReader(
      () => Promise.reject(new Error('Coolify did not answer')),
      () => scanOf(FIXTURE),
    )
    const summary = await scan('coolify', down)
    expect(summary.errors[0]).toMatchObject({ source: 'coolify', subject: 'main' })
    expect(note('image_only')).toMatchObject({ state: 'fixed' })
    expect(byPackage('example-render')).toMatchObject({ state: 'open' })
  })

  it('keeps the note when Coolify does not scan the resource', async () => {
    const off = { ...FIXTURE, off_reason: 'server', images: [], findings: [] }
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(off)),
    )
    expect(note('image_only')).toMatchObject({ state: 'open' })
    expect(docs().imageScannedAt).toBeNull()
  })

  it('reopens the note and resolves the partial note when the setting is turned off', async () => {
    await scan(
      'coolify',
      fakeReader(available(), () => scanOf(FIXTURE)),
    )
    await scan('off')
    expect(note('image_only')).toMatchObject({ state: 'open' })
    expect(note('image_scan_partial')).toMatchObject({ state: 'fixed' })
  })
})

describe('applyCoverageNotes without an image scan', () => {
  it('behaves as before when no coverage is given', async () => {
    await scan('off')
    const changes = applyCoverageNotes(repos, indexDeployments(repos), clock)
    expect(changes).toEqual([])
    expect(note('image_only')).toMatchObject({ state: 'open' })
  })
})

describe('runImageScan', () => {
  it('reads nothing when the mode is off', async () => {
    await scan('off')
    const reader = fakeReader(available(), () => scanOf(FIXTURE))
    const result = await runImageScan(
      repos,
      sources('off', reader).coolify,
      indexDeployments(repos),
      { mode: 'off', now: clock },
    )
    expect(reader.reads).toEqual([])
    expect(result.coverage.size).toBe(0)
  })
})

describe('the Coolify source end to end', () => {
  it('probes once, reads the image only app and serves the partial note type', async () => {
    const asked: string[] = []
    const fetch = (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url)
      const path = url.pathname.replace('/api/v1', '')
      asked.push(path)
      if (path === '/applications') {
        return Promise.resolve(
          json([
            {
              uuid: 'app-docs',
              name: 'static-docs',
              docker_registry_image_name: 'ghcr.io/kestrel-co/static-docs',
              fqdn: 'https://docs.example.dev',
              status: 'running:healthy',
            },
          ]),
        )
      }
      if (path === '/vulnerabilities') {
        return Promise.resolve(
          json({ is_image_scanning_allowed: true, resources: [{ uuid: 'app-docs' }] }),
        )
      }
      if (path === '/applications/app-docs/vulnerabilities') return Promise.resolve(json(FIXTURE))
      return Promise.resolve(json([]))
    }
    repos.settings.set(SCAN_SETTING_KEYS.imageScan, 'coolify')
    const built = buildScanSources(repos, { fetch })
    const summary = await runScan({ repositories: repos }, built, { now: () => clock })
    expect(summary.status).toBe('succeeded')
    expect(asked.filter((p) => p.includes('vulnerabilities'))).toEqual([
      '/vulnerabilities',
      '/applications/app-docs/vulnerabilities',
    ])
    expect(imageFindings()).toHaveLength(2)
    expect(coverageNoteTypeOf(note('image_scan_partial')!)).toBe('image_scan_partial')
  })
})

describe('coverageNoteTypeOf', () => {
  it('knows the partial image scan note', () => {
    const note = (dedupeKey: string) => ({ kind: 'coverage_note' as const, dedupeKey })
    expect(coverageNoteTypeOf(note('note:image_scan_partial:deployment:4'))).toBe(
      'image_scan_partial',
    )
    expect(coverageNoteTypeOf(note('note:__proto__:deployment:4'))).toBeNull()
  })
})
