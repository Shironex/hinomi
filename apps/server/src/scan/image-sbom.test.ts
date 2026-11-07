import type { DeploymentRecord, OsvQuery, OsvVulnerability } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import { coverageNoteFindingKey, type Repositories } from '../repository/index.js'
import type { ImageScanProbe, ResourceScanResult } from '../sources/coolify/index.js'
import { createOsvClient } from '../sources/osv/index.js'
import { createImageSbomReader } from '../sources/registry/index.js'
import {
  CDN_HOST,
  EDGE_API_SPDX_PACKAGES,
  fakeImage,
  fakeRegistry,
  type FakeImage,
  type FakeRegistry,
  urlOf,
} from '../sources/registry/testing.js'
import { imageRefsOf } from './image-sbom.js'
import { imageFindingOf, matchImagePackages } from './image-sbom-match.js'
import { runScan } from './run.js'
import { SCAN_SETTING_KEYS } from './settings.js'
import { buildScanSources, type ImageScanReader, type ScanSources } from './sources.js'

// A fictional world: one Coolify instance runs edge-api, an image only app on edge-1 built from
// ghcr.io/kestrel-co/edge-api:2.3.0 (Alpine 3.20 with a Go binary). Its registry publishes a
// BuildKit SBOM attestation. OSV knows one openssl advisory in Alpine 3.20 (and one only in 3.19),
// two golang.org/x/net advisories (one fixed before the version in the image) and one musl
// advisory with no fix.

const EDGE = 'ghcr.io/kestrel-co/edge-api:2.3.0'

const VULNS: Record<string, OsvVulnerability> = {
  'ALPINE-CVE-2026-1001': {
    id: 'ALPINE-CVE-2026-1001',
    details: 'A crafted certificate makes the edge TLS handshake read past a buffer.\nMore text.',
    upstream: ['CVE-2026-1001'],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [
      {
        package: { name: 'openssl', ecosystem: 'Alpine:v3.19' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.1.5-r0' }] }],
      },
      {
        package: { name: 'openssl', ecosystem: 'Alpine:v3.20' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.3.2-r0' }] }],
      },
    ],
  },
  'ALPINE-CVE-2026-1002': {
    id: 'ALPINE-CVE-2026-1002',
    upstream: ['CVE-2026-1002'],
    affected: [
      {
        package: { name: 'openssl', ecosystem: 'Alpine:v3.19' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.1.6-r0' }] }],
      },
    ],
  },
  'ALPINE-CVE-2026-1003': {
    id: 'ALPINE-CVE-2026-1003',
    upstream: ['CVE-2026-1003'],
    affected: [
      {
        package: { name: 'musl', ecosystem: 'Alpine:v3.20' },
        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }],
      },
    ],
  },
  'GO-2026-0001': {
    id: 'GO-2026-0001',
    summary: 'Excessive memory use when parsing edge headers',
    aliases: ['GHSA-2c3v-4w5x-6r7q', 'CVE-2026-2002'],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
    affected: [
      {
        package: { name: 'golang.org/x/net', ecosystem: 'Go' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.23.0' }] }],
      },
    ],
  },
  'GO-2026-0002': {
    id: 'GO-2026-0002',
    aliases: ['CVE-2026-2003'],
    affected: [
      {
        package: { name: 'golang.org/x/net', ecosystem: 'Go' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.19.0' }] }],
      },
    ],
  },
}

/** Ids OSV answers per `ecosystem name version` (its own matching, coarse on purpose). */
const HITS: Record<string, string[]> = {
  'Alpine:v3.20 openssl 3.3.1-r0': ['ALPINE-CVE-2026-1001', 'ALPINE-CVE-2026-1002'],
  'Alpine:v3.20 musl 1.2.5-r0': ['ALPINE-CVE-2026-1003'],
  'Go golang.org/x/net 0.20.0': ['GO-2026-0001', 'GO-2026-0002'],
}
const keyOf = (q: OsvQuery) => `${q.package.ecosystem} ${q.package.name} ${q.version}`

interface FakeOsv {
  fetch: typeof fetch
  batches: number
  queries: string[]
  fail: boolean
}

function fakeOsv(): FakeOsv {
  const state: FakeOsv = {
    batches: 0,
    queries: [],
    fail: false,
    fetch: (input, init) => {
      const url = urlOf(input)
      if (state.fail) return Promise.resolve(new Response('down', { status: 503 }))
      const body = JSON.parse(init?.body as string) as { queries?: OsvQuery[] } & OsvQuery
      if (url.endsWith('/v1/querybatch')) {
        state.batches++
        const results = (body.queries ?? []).map((q) => ({
          vulns: (HITS[keyOf(q)] ?? []).map((id) => ({ id })),
        }))
        return Promise.resolve(Response.json({ results }))
      }
      if (url.endsWith('/v1/query')) {
        state.queries.push(keyOf(body))
        return Promise.resolve(
          Response.json({ vulns: (HITS[keyOf(body)] ?? []).map((id) => VULNS[id]) }),
        )
      }
      return Promise.reject(new Error(`unexpected OSV call ${url}`))
    },
  }
  return state
}

let handle: DatabaseHandle
let repos: Repositories
let clock: Date
let sourceId: number
let registry: FakeRegistry
let osv: FakeOsv

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    source: 'main',
    externalId: 'app-edge',
    name: 'edge-api',
    kind: 'application',
    repo: null,
    branch: null,
    gitRepository: null,
    domains: ['https://edge.example.dev'],
    isPublic: true,
    server: 'edge-1',
    status: 'running:healthy',
    image: EDGE,
    lastDeployAt: null,
    watchPaths: null,
    ...overrides,
  }
}

let records: DeploymentRecord[]

interface SourcesOptions {
  coolifyReader?: ImageScanReader
  osvOn?: boolean
  maxPackages?: number
  fetch?: typeof fetch
}

function sources(mode: 'off' | 'coolify' | 'sbom', options: SourcesOptions = {}): ScanSources {
  return {
    coolify: [
      {
        sourceId,
        name: 'main',
        fetchInventory: () => Promise.resolve(records),
        ...(options.coolifyReader && { imageScan: options.coolifyReader }),
      },
    ],
    github: [],
    osv:
      options.osvOn === false
        ? null
        : { sourceId: null, client: createOsvClient({ fetch: osv.fetch, maxRetries: 0 }) },
    fetchLockfiles: () => Promise.resolve([]),
    imageSbom: createImageSbomReader({
      fetch: options.fetch ?? registry.fetch,
      lookup: registry.lookup,
      ...(options.maxPackages !== undefined && { maxPackages: options.maxPackages }),
    }),
    settings: { osvEnabled: true, includeAccountRepos: false, imageScan: mode },
  }
}

const scan = (mode: 'off' | 'coolify' | 'sbom', options?: SourcesOptions) =>
  runScan({ repositories: repos }, sources(mode, options), { now: () => clock })

const edge = () => repos.deployments.list().find((d) => d.name === 'edge-api')!
const note = (type: 'image_only' | 'image_scan_partial' | 'image_sbom_unavailable') =>
  repos.findings.getByKey(coverageNoteFindingKey(type, edge().id))
const lastDetails = (type: 'image_sbom_unavailable' | 'image_scan_partial') =>
  repos.findings.listEvents(note(type)!.id).find((e) => e.type === 'details')?.data
const imageFindings = () =>
  repos.findings.list({ deploymentId: edge().id, kind: 'advisory' }).map((f) => ({
    ...f,
    advisory: repos.advisories.get(f.advisoryId!)!,
  }))
const byPackage = (name: string) => imageFindings().find((f) => f.advisory.packageName === name)

function useImages(...images: FakeImage[]) {
  registry = fakeRegistry('ghcr.io', images)
}

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  clock = new Date('2026-11-08T10:00:00Z')
  sourceId = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  }).id
  records = [record()]
  useImages(fakeImage('kestrel-co/edge-api', '2.3.0'))
  osv = fakeOsv()
})

afterEach(() => handle.close())

describe('image scan from registry SBOMs', () => {
  it('is not used in coolify mode', async () => {
    await scan('coolify')
    expect(registry.requests).toEqual([])
    expect(note('image_only')).toMatchObject({ state: 'open' })
  })

  it('turns the SBOM packages into advisory findings matched on OSV', async () => {
    await scan('off')
    const summary = await scan('sbom')
    expect(summary.status).toBe('succeeded')
    expect(summary.sourceResults.osv?.counts).toMatchObject({
      imageSboms: 1,
      imageSbomsRead: 1,
      imageSbomsCached: 0,
    })

    expect(
      imageFindings()
        .map((f) => f.advisory.advisoryKey)
        .sort(),
    ).toEqual(['CVE-2026-1001', 'CVE-2026-1003', 'GHSA-2c3v-4w5x-6r7q'])
    const openssl = byPackage('openssl')!
    expect(openssl).toMatchObject({
      state: 'open',
      reportedBy: ['image'],
      repoId: null,
      scope: 'runtime',
      installedVersion: '3.3.1-r0',
      evidence: {
        imageScan: 'sbom',
        imageRefs: [EDGE],
        scannedAt: '2026-11-08T10:00:00.000Z',
        kev: false,
        epss: null,
        risk: null,
        fixState: 'fixed',
        packageType: 'apk',
      },
    })
    expect(openssl.advisory).toMatchObject({
      ecosystem: 'apk',
      cveIds: ['CVE-2026-1001'],
      severity: 'critical',
      cvssScore: 9.8,
      firstPatchedVersion: '3.3.2-r0',
      summary: 'A crafted certificate makes the edge TLS handshake read past a buffer.',
      url: 'https://osv.dev/vulnerability/ALPINE-CVE-2026-1001',
    })
    expect(byPackage('golang.org/x/net')!.advisory).toMatchObject({
      ghsaId: 'GHSA-2c3v-4w5x-6r7q',
      ecosystem: 'Go',
      severity: 'high',
      firstPatchedVersion: '0.23.0',
    })
    expect(byPackage('musl')).toMatchObject({ evidence: { fixState: 'no_fix' } })

    // Only vulnerable packages were asked for full records.
    expect(osv.queries.sort()).toEqual([
      'Alpine:v3.20 musl 1.2.5-r0',
      'Alpine:v3.20 openssl 3.3.1-r0',
      'Go golang.org/x/net 0.20.0',
    ])

    expect(note('image_only')).toMatchObject({ state: 'fixed' })
    expect(repos.findings.listEvents(note('image_only')!.id)[0]).toMatchObject({
      type: 'resolved',
      data: { coveredBy: 'image_scan', mode: 'sbom' },
    })
    expect(note('image_sbom_unavailable')).toBeUndefined()
    expect(note('image_scan_partial')).toBeUndefined()
    expect(edge().imageScannedAt).toBeNull()
  })

  it('does not read an unchanged digest again, and fixes what OSV no longer lists', async () => {
    await scan('sbom')
    registry.requests.length = 0
    delete HITS['Alpine:v3.20 musl 1.2.5-r0']
    try {
      clock = new Date('2026-11-08T11:00:00Z')
      const summary = await scan('sbom')
      expect(summary.sourceResults.osv?.counts).toMatchObject({
        imageSbomsRead: 0,
        imageSbomsCached: 1,
      })
    } finally {
      HITS['Alpine:v3.20 musl 1.2.5-r0'] = ['ALPINE-CVE-2026-1003']
    }
    // One HEAD (after the anonymous token), no manifest or blob read.
    expect(registry.requests).toEqual([
      'HEAD https://ghcr.io/v2/kestrel-co/edge-api/manifests/2.3.0',
      'GET https://ghcr.io/token',
      'HEAD https://ghcr.io/v2/kestrel-co/edge-api/manifests/2.3.0',
    ])
    expect(byPackage('musl')).toMatchObject({ state: 'fixed' })
    expect(byPackage('openssl')).toMatchObject({ state: 'open' })
  })

  it('reads the image again when its tag points at a new digest', async () => {
    await scan('sbom')
    useImages(
      fakeImage('kestrel-co/edge-api', '2.3.0', {
        spdxPackages: [
          {
            externalRefs: [
              {
                referenceType: 'purl',
                referenceLocator: 'pkg:apk/alpine/musl@1.2.5-r0?distro=alpine-3.20.2',
              },
            ],
          },
        ],
      }),
    )
    const summary = await scan('sbom')
    expect(summary.sourceResults.osv?.counts).toMatchObject({ imageSbomsRead: 1 })
    expect(byPackage('openssl')).toMatchObject({ state: 'fixed' })
    expect(byPackage('musl')).toMatchObject({ state: 'open' })
  })

  it('lets Coolify results win: the registry is not asked when Coolify covers the deployment', async () => {
    const coolifyScan: ResourceScanResult = {
      status: 'ok',
      scan: {
        offReason: null,
        images: [{ imageRef: EDGE, status: 'completed', scannedAt: clock, truncated: false }],
        findings: [],
        truncatedImages: [],
        capped: false,
        unreadable: 0,
      },
    }
    // An SBOM scan first, then Coolify starts covering it: its complete result wins.
    await scan('off')
    await scan('sbom')
    expect(imageFindings().length).toBeGreaterThan(0)
    registry.requests.length = 0
    const probe: ImageScanProbe = { status: 'available', checkedAt: new Map() }
    const coolifyReader: ImageScanReader = {
      probe: () => Promise.resolve(probe),
      resource: () => Promise.resolve(coolifyScan),
    }
    await scan('sbom', { coolifyReader })
    expect(registry.requests).toEqual([])
    expect(imageFindings().every((f) => f.state === 'fixed')).toBe(true)
    expect(note('image_only')).toMatchObject({ state: 'fixed' })
  })

  it('falls back to the SBOM when the Coolify instance has no image scan', async () => {
    const coolifyReader: ImageScanReader = {
      probe: () => Promise.resolve({ status: 'unavailable', reason: 'no_endpoint' }),
      resource: () => Promise.reject(new Error('must not be read')),
    }
    const summary = await scan('sbom', { coolifyReader })
    expect(summary.sourceResults.coolify?.counts).toMatchObject({ imageScanUnavailable: 1 })
    expect(imageFindings()).toHaveLength(3)
  })

  it('opens a note with the reason when the image has no SBOM', async () => {
    useImages(fakeImage('kestrel-co/edge-api', '2.3.0', { spdxPackages: null }))
    const summary = await scan('sbom')
    expect(summary.status).toBe('succeeded')
    expect(note('image_only')).toMatchObject({ state: 'open' })
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'open' })
    expect(lastDetails('image_sbom_unavailable')).toEqual({
      images: [
        {
          imageRef: EDGE,
          reason: 'no_sbom',
          detail: 'The attestations for linux/amd64 carry no SPDX or CycloneDX SBOM.',
        },
      ],
    })

    // A private image: the reason changes, and the note says so.
    useImages()
    registry.requests.length = 0
    await scan('sbom')
    expect(lastDetails('image_sbom_unavailable')).toMatchObject({
      images: [{ imageRef: EDGE, reason: 'not_found' }],
    })
  })

  it('resolves the note when Coolify starts covering the deployment', async () => {
    useImages(fakeImage('kestrel-co/edge-api', '2.3.0', { spdxPackages: null }))
    await scan('sbom')
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'open' })
    const coolifyReader: ImageScanReader = {
      probe: () => Promise.resolve({ status: 'available', checkedAt: new Map() }),
      resource: () =>
        Promise.resolve({
          status: 'ok',
          scan: {
            offReason: null,
            images: [{ imageRef: EDGE, status: 'completed', scannedAt: clock, truncated: false }],
            findings: [],
            truncatedImages: [],
            capped: false,
            unreadable: 0,
          },
        }),
    }
    await scan('sbom', { coolifyReader })
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'fixed' })
    expect(repos.findings.listEvents(note('image_sbom_unavailable')!.id)[0]).toMatchObject({
      data: { coveredBy: 'image_scan', mode: 'coolify' },
    })
  })

  it('says why for an unparsable reference and for every image of a service', async () => {
    records = [record({ kind: 'service', image: 'ghcr.io/kestrel-co/edge-api:${TAG}, redis:7' })]
    registry = fakeRegistry('ghcr.io', [])
    await scan('sbom', {
      fetch: (input) =>
        urlOf(input).includes('docker.io')
          ? Promise.resolve(
              new Response(null, {
                status: 401,
                headers: { 'www-authenticate': 'Basic realm="x"' },
              }),
            )
          : registry.fetch(input),
    })
    expect(lastDetails('image_sbom_unavailable')).toMatchObject({
      images: [
        { imageRef: 'ghcr.io/kestrel-co/edge-api:${TAG}', reason: 'unparsable_ref' },
        { imageRef: 'redis:7', reason: 'unauthorized' },
      ],
    })
  })

  it('leaves findings alone and says why when the registry cannot be reached', async () => {
    await scan('off')
    await scan('sbom')
    const before = imageFindings().map((f) => f.state)
    await scan('sbom', { fetch: () => Promise.reject(new Error('ECONNRESET')) })
    expect(imageFindings().map((f) => f.state)).toEqual(before)
    expect(note('image_only')).toMatchObject({ state: 'fixed' })
    expect(lastDetails('image_sbom_unavailable')).toMatchObject({
      images: [{ imageRef: EDGE, reason: 'error' }],
    })
    // Back to normal: the note resolves.
    await scan('sbom')
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'fixed' })
  })

  it('records an OSV outage once and leaves things alone', async () => {
    await scan('sbom')
    osv.fail = true
    const summary = await scan('sbom')
    expect(summary.status).toBe('partial')
    expect(summary.errors).toEqual([expect.objectContaining({ source: 'osv', subject: 'OSV' })])
    expect(imageFindings().every((f) => f.state === 'open')).toBe(true)
  })

  it('says osv_off without asking the registry when OSV is switched off', async () => {
    await scan('sbom', { osvOn: false })
    expect(registry.requests).toEqual([])
    expect(lastDetails('image_sbom_unavailable')).toMatchObject({
      images: [{ imageRef: EDGE, reason: 'osv_off' }],
    })
  })

  it('treats a capped package list as partial: the note opens and nothing is fixed', async () => {
    await scan('sbom')
    // A new digest (one more package) read with a cap of one package.
    useImages(
      fakeImage('kestrel-co/edge-api', '2.3.0', {
        spdxPackages: [
          ...EDGE_API_SPDX_PACKAGES,
          {
            externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/edge-utils@2.0.0' }],
          },
        ],
      }),
    )
    await scan('sbom', { maxPackages: 1 })
    expect(note('image_scan_partial')).toMatchObject({ state: 'open' })
    expect(lastDetails('image_scan_partial')).toMatchObject({ truncatedImages: [EDGE] })
    expect(imageFindings().filter((f) => f.state === 'open')).toHaveLength(3)
    // Back to the first image, read in full: the note resolves.
    useImages(fakeImage('kestrel-co/edge-api', '2.3.0'))
    await scan('sbom')
    expect(note('image_scan_partial')).toMatchObject({ state: 'fixed' })
  })

  it('resolves its notes when the mode is switched off', async () => {
    useImages(fakeImage('kestrel-co/edge-api', '2.3.0', { spdxPackages: null }))
    await scan('sbom')
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'open' })
    await scan('coolify')
    expect(note('image_sbom_unavailable')).toMatchObject({ state: 'fixed' })
  })

  it('runs end to end through buildScanSources with the stored setting', async () => {
    repos.settings.set(SCAN_SETTING_KEYS.imageScan, 'sbom')
    registry = fakeRegistry('ghcr.io', [fakeImage('kestrel-co/edge-api', '2.3.0')], {
      redirectBlobs: false,
    })
    const built = buildScanSources(repos, {
      fetch: (input, init) => {
        const url = urlOf(input)
        if (url.startsWith('https://api.osv.dev/')) return osv.fetch(input, init)
        if (url.startsWith('https://ghcr.io/')) return registry.fetch(input, init)
        return Promise.reject(new Error(`unexpected ${url}`))
      },
      osvMaxRetries: 0,
    })
    expect(built.settings.imageScan).toBe('sbom')
    await runScan(
      { repositories: repos },
      {
        ...built,
        coolify: [{ sourceId, name: 'main', fetchInventory: () => Promise.resolve(records) }],
      },
      { now: () => clock },
    )
    expect(imageFindings()).toHaveLength(3)
    expect(registry.requests.some((r) => r.includes(CDN_HOST))).toBe(false)
  })
})

describe('helpers', () => {
  it('splits the image list of a service and caps it', () => {
    expect(imageRefsOf({ image: 'redis:7, ghcr.io/kestrel-co/edge-api:2.3.0, redis:7' })).toEqual([
      'redis:7',
      'ghcr.io/kestrel-co/edge-api:2.3.0',
    ])
    expect(imageRefsOf({ image: null })).toEqual([])
    const many = Array.from({ length: 20 }, (_, i) => `img${i}:1`).join(',')
    expect(imageRefsOf({ image: many })).toHaveLength(10)
  })

  it('skips withdrawn records and records about another package', () => {
    const pkg = {
      ecosystem: 'Alpine:v3.20',
      name: 'openssl',
      version: '3.3.1-r0',
      packageType: 'apk',
      storedEcosystem: 'apk',
      localCheck: false,
    }
    const vuln = VULNS['ALPINE-CVE-2026-1001']!
    expect(imageFindingOf(vuln, pkg, EDGE)?.displayId).toBe('CVE-2026-1001')
    expect(imageFindingOf({ ...vuln, withdrawn: '2026-11-01T00:00:00Z' }, pkg, EDGE)).toBeNull()
    expect(imageFindingOf(vuln, { ...pkg, name: 'zlib' }, EDGE)).toBeNull()
  })

  it('keeps one finding when OSV returns a GHSA record and a Go record for one issue', async () => {
    const goRecord = VULNS['GO-2026-0001']!
    const ghsaRecord: OsvVulnerability = {
      ...goRecord,
      id: 'GHSA-2c3v-4w5x-6r7q',
      aliases: ['GO-2026-0001', 'CVE-2026-2002'],
    }
    const client = createOsvClient({
      fetch: (input) =>
        Promise.resolve(
          urlOf(input).endsWith('/v1/querybatch')
            ? Response.json({ results: [{ vulns: [{ id: 'GO-2026-0001' }] }] })
            : Response.json({ vulns: [goRecord, ghsaRecord] }),
        ),
    })
    const pkg = {
      ecosystem: 'Go',
      name: 'golang.org/x/net',
      version: '0.20.0',
      packageType: 'golang',
      storedEcosystem: 'Go',
      localCheck: true,
    }
    const { findings } = await matchImagePackages(client, [pkg], EDGE)
    expect(findings.map((f) => f.id)).toEqual(['GHSA-2c3v-4w5x-6r7q'])
  })

  it('keeps names like __proto__ as plain values', () => {
    const pkg = {
      ecosystem: 'npm',
      name: '__proto__',
      version: '1.0.0',
      packageType: 'npm',
      storedEcosystem: 'npm',
      localCheck: false,
    }
    const finding = imageFindingOf(
      {
        id: 'GHSA-2c3v-4w5x-6r7q',
        affected: [{ package: { name: '__proto__', ecosystem: 'npm' }, ranges: [] }],
      },
      pkg,
      EDGE,
    )
    expect(finding?.packageName).toBe('__proto__')
    expect(({} as Record<string, unknown>).version).toBeUndefined()
  })
})
