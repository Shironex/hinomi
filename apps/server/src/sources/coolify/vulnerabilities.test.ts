import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCoolifyClient } from './client.js'
import { CoolifyError } from './errors.js'
import { ecosystemOfPackageType, fetchResourceScan, probeImageScan } from './vulnerabilities.js'

const BASE = 'https://coolify.example.dev'
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/vulnerabilities.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A client whose fetch answers by path (query included); records every path asked. */
function clientFor(answer: (path: string) => Response) {
  const asked: string[] = []
  const client = createCoolifyClient({
    baseUrl: BASE,
    token: 'coolify-token-fictional-0001',
    fetch: (input) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url)
      const path = `${url.pathname.replace('/api/v1', '')}${url.search}`
      asked.push(path)
      return Promise.resolve(answer(path))
    },
  })
  return { client, asked }
}

describe('probeImageScan', () => {
  it('treats a 404 as a Coolify without image scan, not an error', async () => {
    const { client } = clientFor(() => json({ message: 'Not found.' }, 404))
    await expect(probeImageScan(client)).resolves.toEqual({
      status: 'unavailable',
      reason: 'no_endpoint',
    })
  })

  it('reports a 403 as a token permission gap with a clear message', async () => {
    const { client } = clientFor(() => json({ message: 'Unauthorized' }, 403))
    const probe = await probeImageScan(client)
    expect(probe).toMatchObject({ status: 'forbidden' })
    expect(probe.status === 'forbidden' && probe.message).toMatch(/read permission/)
  })

  it('says unavailable when the instance does not allow image scanning', async () => {
    const { client } = clientFor(() => json({ is_image_scanning_allowed: false, resources: [] }))
    await expect(probeImageScan(client)).resolves.toEqual({
      status: 'unavailable',
      reason: 'disabled',
    })
  })

  it('finds scanning off in a 4.7.0 list where no resource was ever checked', async () => {
    const { client } = clientFor(() => json(fixture('vulnerabilities-list-off')))
    await expect(probeImageScan(client)).resolves.toEqual({
      status: 'unavailable',
      reason: 'disabled',
    })
  })

  it('is available as soon as one resource has a verdict', async () => {
    const { client } = clientFor(() => json(fixture('vulnerabilities-list-on')))
    const probe = await probeImageScan(client)
    if (probe.status !== 'available') throw new Error('expected available')
    expect(probe.checkedAt.get('app-docs')).toBe('2026-11-07T08:00:00+00:00')
    expect(probe.checkedAt.get('svc-wiki')).toBeNull()
  })

  it('stays available for an instance without resources', async () => {
    const { client } = clientFor(() => json({ resources: [] }))
    await expect(probeImageScan(client)).resolves.toMatchObject({ status: 'available' })
  })

  it('throws a rate limit with the wait Coolify asked for', async () => {
    const { client } = clientFor(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '45' } }),
    )
    await expect(probeImageScan(client)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 45,
    })
  })

  it('maps each resource to its change marker, in a Map', async () => {
    const { client } = clientFor(() =>
      json({
        is_image_scanning_allowed: true,
        resources: [
          { uuid: 'app-docs', security: { checked_at: '2026-11-07T08:00:00+00:00' } },
          { uuid: '__proto__', security: null },
          { uuid: 'constructor', security: { checked_at: null } },
        ],
      }),
    )
    const probe = await probeImageScan(client)
    if (probe.status !== 'available') throw new Error('expected available')
    expect(probe.checkedAt.get('app-docs')).toBe('2026-11-07T08:00:00+00:00')
    expect(probe.checkedAt.get('__proto__')).toBeNull()
    expect(probe.checkedAt.get('constructor')).toBeNull()
    expect(({} as Record<string, unknown>).checked_at).toBeUndefined()
  })

  it('throws on a body that is not the documented shape', async () => {
    const { client } = clientFor(() => json([]))
    await expect(probeImageScan(client)).rejects.toBeInstanceOf(CoolifyError)
  })

  it('throws on other failures so the next scan retries', async () => {
    const { client } = clientFor(() => json({}, 502))
    await expect(probeImageScan(client)).rejects.toMatchObject({ code: 'server_error' })
  })
})

describe('fetchResourceScan', () => {
  it('maps the documented response', async () => {
    const { client, asked } = clientFor(() => json(FIXTURE))
    const result = await fetchResourceScan(client, 'application', 'app-docs')
    expect(asked).toEqual(['/applications/app-docs/vulnerabilities?per_page=200&page=1'])
    if (result.status !== 'ok') throw new Error('expected ok')
    const { scan } = result
    expect(scan.offReason).toBeNull()
    expect(scan.truncatedImages).toEqual(['ghcr.io/kestrel-co/static-docs-sidecar:2.0.1'])
    expect(scan.capped).toBe(false)
    expect(scan.unreadable).toBe(0)
    expect(scan.images[0]).toMatchObject({
      imageRef: 'ghcr.io/kestrel-co/static-docs:1.4.0',
      status: 'completed',
      scannedAt: new Date('2026-11-07T07:55:00Z'),
      truncated: false,
    })
    expect(scan.findings[0]).toMatchObject({
      id: 'CVE-2026-1001',
      ids: ['CVE-2026-1001', 'GHSA-x4mq-7p2v-c9hw'],
      severity: 'critical',
      packageName: 'example-render',
      version: '2.1.0',
      ecosystem: 'npm',
      fixedIn: '2.1.4',
      state: 'fixed',
      kev: true,
      epss: 0.41,
      cvssScore: 9.8,
      advisoryUrl: 'https://osv.dev/vulnerability/CVE-2026-1001',
    })
    expect(scan.findings[1]).toMatchObject({
      ids: ['DEBIAN-CVE-2026-2002', 'CVE-2026-2002'],
      severity: 'moderate',
      ecosystem: 'deb',
      fixedIn: null,
      state: 'ignored',
      ignoreReason: 'not reachable in this image',
      // Only http and https links are kept.
      advisoryUrl: null,
    })
  })

  it('reads the verdict, owners, exploited counts, actions, eol and failed scans', async () => {
    const { client } = clientFor(() => json(fixture('vulnerabilities-service')))
    const result = await fetchResourceScan(client, 'service', 'svc-wiki')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.scan.security).toEqual({
      status: 'update_available',
      anyExploited: false,
      exploitedCount: 0,
      actions: [
        {
          type: 'bump_image',
          sentence: 'Move wiki-app to 3.2.1 to fix 1 high finding.',
          target: '3.2.1',
          image: 'ghcr.io/kestrel-co/wiki-app:3.1.0',
        },
      ],
      eol: { name: 'debian', version: '10', fixed: true },
      checkedAt: '2026-11-07T09:00:00+00:00',
    })
    expect(result.scan.images.map((i) => [i.ownerUuid, i.status, i.errorCode])).toEqual([
      ['svc-wiki-app', 'completed', null],
      ['svc-wiki-cache', 'failed', 'image_pull_failed'],
    ])
    expect(result.scan.findings[0]).toMatchObject({ ownerUuid: 'svc-wiki-app' })
  })

  it('reads the exploited fields of the first fixture', async () => {
    const { client } = clientFor(() => json(FIXTURE))
    const result = await fetchResourceScan(client, 'application', 'app-docs')
    expect(result.status === 'ok' && result.scan.security).toMatchObject({
      status: 'update_now',
      anyExploited: true,
      exploitedCount: 1,
      eol: null,
    })
  })

  it('says why Coolify does not scan the resource, for both 4.7.0 off reasons', async () => {
    const off = fixture('vulnerabilities-off-server') as Record<string, unknown>
    for (const reason of ['server', 'application']) {
      const { client, asked } = clientFor(() => json({ ...off, off_reason: reason }))
      const result = await fetchResourceScan(client, 'application', 'app-docs')
      if (result.status !== 'ok') throw new Error('expected ok')
      expect(result.scan).toMatchObject({
        offReason: reason,
        images: [],
        findings: [],
        capped: false,
        unreadable: 0,
      })
      expect(result.scan.security).toMatchObject({ status: 'not_checked', checkedAt: null })
      // An empty first page with a total of 0 is the whole answer.
      expect(asked).toHaveLength(1)
    }
  })

  it('has no verdict for a status it does not know', async () => {
    const body = { ...(FIXTURE as object), security: { status: 'brand_new_state' } }
    const { client } = clientFor(() => json(body))
    const result = await fetchResourceScan(client, 'application', 'app-docs')
    expect(result.status === 'ok' && result.scan.security).toBeNull()
  })

  it('answers rate_limited with the wait, and does not ask again', async () => {
    const { client, asked } = clientFor(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    )
    const result = await fetchResourceScan(client, 'application', 'app-docs')
    expect(result).toMatchObject({ status: 'rate_limited', retryAfterSeconds: 30 })
    expect(result.status === 'rate_limited' && result.message).toMatch(/retry after 30 s/)
    expect(asked).toHaveLength(1)
  })

  it('reads every page up to the total', async () => {
    const finding = (n: number) => ({
      id: `CVE-2026-${String(3000 + n)}`,
      package: `pkg-${n}`,
      version: '1.0.0',
      package_type: 'apk',
    })
    const page = (p: number) =>
      Array.from({ length: p === 1 ? 200 : 5 }, (_, i) => finding((p - 1) * 200 + i))
    const { client, asked } = clientFor((path) => {
      const p = Number(new URLSearchParams(path.split('?')[1]).get('page'))
      return json({ images: [], findings: page(p), pagination: { total: 205 } })
    })
    const result = await fetchResourceScan(client, 'service', 'svc-1')
    expect(asked).toHaveLength(2)
    expect(result.status === 'ok' && result.scan.findings).toHaveLength(205)
    expect(result.status === 'ok' && result.scan.capped).toBe(false)
  })

  it('stops at the page limit and says the result is capped', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `CVE-2026-${String(4000 + i)}`,
      package: 'pkg',
      version: '1',
    }))
    const { client, asked } = clientFor(() => json({ findings: rows, pagination: { total: 5000 } }))
    const result = await fetchResourceScan(client, 'database', 'db-1', { maxPages: 2 })
    expect(asked).toHaveLength(2)
    expect(result.status === 'ok' && result.scan.capped).toBe(true)
  })

  it('drops and counts entries that do not parse', async () => {
    const { client } = clientFor(() =>
      json({
        images: [{ image_ref: 'nginx:1.27' }, { image_ref: 42 }],
        findings: [
          { id: 'CVE-2026-5001', package: 'zlib', version: '1.3', package_type: 'apk' },
          { id: '', package: 'x', version: '1' },
          'not an object',
        ],
        pagination: { total: 3 },
      }),
    )
    const result = await fetchResourceScan(client, 'application', 'app-1')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.scan.findings).toHaveLength(1)
    expect(result.scan.images).toHaveLength(1)
    expect(result.scan.unreadable).toBe(3)
  })

  it('answers not_found and forbidden instead of throwing', async () => {
    const gone = clientFor(() => json({ message: 'Application not found.' }, 404))
    await expect(fetchResourceScan(gone.client, 'application', 'x')).resolves.toEqual({
      status: 'not_found',
    })
    const denied = clientFor(() => json({ message: 'Forbidden' }, 403))
    await expect(fetchResourceScan(denied.client, 'application', 'x')).resolves.toMatchObject({
      status: 'forbidden',
    })
  })

  it('escapes the uuid in the path', async () => {
    const { client, asked } = clientFor(() => json({ findings: [] }))
    await fetchResourceScan(client, 'application', '../servers')
    expect(asked[0]).toBe('/applications/..%2Fservers/vulnerabilities?per_page=200&page=1')
  })
})

describe('ecosystemOfPackageType', () => {
  it('maps language package types to advisory ecosystems and keeps OS types', () => {
    expect(ecosystemOfPackageType('gomod')).toBe('Go')
    expect(ecosystemOfPackageType('python-pkg')).toBe('PyPI')
    expect(ecosystemOfPackageType('cargo')).toBe('rust')
    expect(ecosystemOfPackageType('deb')).toBe('deb')
    expect(ecosystemOfPackageType('__proto__')).toBe('__proto__')
    expect(ecosystemOfPackageType('constructor')).toBe('constructor')
  })
})
