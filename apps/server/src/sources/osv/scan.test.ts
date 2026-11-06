import { osvAdvisoryMatchSchema, type OsvVulnerability } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createOsvClient } from './client.js'
import { scanLockfile } from './scan.js'

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { 'kestrel-http': '^2.0.0' }, devDependencies: { 'tern-test': '^1.0.0' } },
    'node_modules/kestrel-http': { version: '2.1.0' },
    'node_modules/plover-parse': { version: '1.2.0' },
    'node_modules/tern-test': { version: '1.4.0', dev: true },
    'node_modules/gull-assert': { version: '5.0.0', dev: true },
  },
})

const VULNS: Record<string, OsvVulnerability> = {
  // Critical GHSA record for the runtime framework.
  'GHSA-aaaa-bbbb-cccc': {
    id: 'GHSA-aaaa-bbbb-cccc',
    summary: 'Remote code execution in kestrel-http request parsing',
    aliases: ['CVE-2026-10001'],
    published: '2026-10-01T12:00:00Z',
    modified: '2026-10-02T12:00:00Z',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    database_specific: { severity: 'CRITICAL' },
    affected: [
      {
        package: { name: 'kestrel-http', ecosystem: 'npm' },
        ranges: [
          {
            type: 'SEMVER',
            events: [
              { introduced: '0' },
              { fixed: '1.9.4' },
              { introduced: '2.0.0' },
              { fixed: '2.1.5' },
            ],
          },
        ],
      },
    ],
  },
  // The same advisory published again under its CVE id: must collapse into the GHSA match.
  'CVE-2026-10001': {
    id: 'CVE-2026-10001',
    aliases: ['GHSA-aaaa-bbbb-cccc'],
    affected: [
      {
        package: { name: 'kestrel-http', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.1.5' }] }],
      },
    ],
  },
  // Not a GHSA id; the GHSA only appears among the aliases. No database severity word.
  'OSV-2026-77': {
    id: 'OSV-2026-77',
    summary: 'Prototype pollution in gull-assert',
    aliases: ['GHSA-dddd-eeee-ffff', 'CVE-2026-20002'],
    published: '2026-09-15T08:00:00Z',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N' }],
    affected: [
      {
        package: { name: 'gull-assert', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { last_affected: '5.0.0' }] }],
      },
    ],
  },
  // Returned by the index but the installed 1.2.0 is outside the range: no match.
  'GHSA-9999-8888-7777': {
    id: 'GHSA-9999-8888-7777',
    summary: 'Old plover-parse bug',
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { name: 'plover-parse', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.1.0' }] }],
      },
    ],
  },
  // Withdrawn records are ignored.
  'GHSA-wwww-wwww-wwww': {
    id: 'GHSA-wwww-wwww-wwww',
    withdrawn: '2026-10-05T00:00:00Z',
    database_specific: { severity: 'LOW' },
    affected: [
      {
        package: { name: 'tern-test', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
      },
    ],
  },
}

const INDEX: Record<string, string[]> = {
  'kestrel-http@2.1.0': ['GHSA-aaaa-bbbb-cccc', 'CVE-2026-10001'],
  'gull-assert@5.0.0': ['OSV-2026-77'],
  'plover-parse@1.2.0': ['GHSA-9999-8888-7777'],
  'tern-test@1.4.0': ['GHSA-wwww-wwww-wwww'],
}

function mockOsv() {
  const calls: string[] = []
  const fetchMock: typeof fetch = (input, init) => {
    const url = input as string
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(init?.body as string) as {
        queries: { package: { name: string }; version: string }[]
      }
      const results = body.queries.map((q) => {
        const ids = INDEX[`${q.package.name}@${q.version}`] ?? []
        return ids.length > 0 ? { vulns: ids.map((id) => ({ id })) } : {}
      })
      return Promise.resolve(Response.json({ results }))
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    const vuln = VULNS[id]
    return Promise.resolve(vuln ? Response.json(vuln) : new Response('{}', { status: 404 }))
  }
  return { calls, client: createOsvClient({ fetch: fetchMock, sleep: () => Promise.resolve() }) }
}

describe('scanLockfile', () => {
  it('maps OSV records to source neutral matches', async () => {
    const { client, calls } = mockOsv()
    const matches = await scanLockfile(LOCK, 'package-lock.json', { client })

    for (const m of matches) expect(() => osvAdvisoryMatchSchema.parse(m)).not.toThrow()
    expect(matches.map((m) => m.osvId).sort()).toEqual(['GHSA-aaaa-bbbb-cccc', 'OSV-2026-77'])

    expect(matches.find((m) => m.package === 'kestrel-http')).toEqual({
      source: 'osv',
      osvId: 'GHSA-aaaa-bbbb-cccc',
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      cveIds: ['CVE-2026-10001'],
      aliases: ['CVE-2026-10001'],
      package: 'kestrel-http',
      ecosystem: 'npm',
      severity: 'critical',
      severityRaw: 'CRITICAL',
      cvss: { score: 9.8, vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      summary: 'Remote code execution in kestrel-http request parsing',
      vulnerableRange: '>= 2.0.0, < 2.1.5',
      firstPatched: '2.1.5',
      publishedAt: '2026-10-01T12:00:00Z',
      modifiedAt: '2026-10-02T12:00:00Z',
      url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
      installedVersion: '2.1.0',
      scope: 'runtime',
      direct: true,
    })

    // One querybatch, then one detail request per unique id.
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(5)
  })

  it('takes the GHSA id from aliases and scores severity from the CVSS vector', async () => {
    const { client } = mockOsv()
    const matches = await scanLockfile(LOCK, 'package-lock.json', { client })
    expect(matches.find((m) => m.package === 'gull-assert')).toMatchObject({
      osvId: 'OSV-2026-77',
      ghsaId: 'GHSA-dddd-eeee-ffff',
      cveIds: ['CVE-2026-20002'],
      severity: 'high',
      severityRaw: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N',
      cvss: { score: 8.2 },
      vulnerableRange: '>= 4.0.0, <= 5.0.0',
      firstPatched: null,
      scope: 'dev',
      direct: false,
    })
  })

  it('does not match a version outside the affected range', async () => {
    const { client } = mockOsv()
    const matches = await scanLockfile(LOCK, 'package-lock.json', { client })
    expect(matches.some((m) => m.package === 'plover-parse')).toBe(false)
    expect(matches.some((m) => m.package === 'tern-test')).toBe(false)
  })

  it('makes no request for a lockfile without registry packages', async () => {
    const { client, calls } = mockOsv()
    const empty = JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })
    expect(await scanLockfile(empty, 'package-lock.json', { client })).toEqual([])
    expect(calls).toEqual([])
  })
})
