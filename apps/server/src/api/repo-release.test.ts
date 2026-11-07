import { findingsResponseSchema, repoDetailSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { releaseCacheKey } from '../scan/releases.js'
import { createTestApi } from './testing.js'

// The desktop release tier as the repo detail shows it, and the per repo tier override.

const AT = new Date('2026-11-08T10:00:00Z')

function world() {
  const api = createTestApi()
  const { repos } = api
  const desk = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-desk' })
  repos.repos.recordReleaseCheck(
    desk.id,
    { tag: 'v2.3.0', publishedAt: new Date('2026-10-01T09:00:00Z'), installers: true },
    AT,
  )
  repos.httpCache.put({
    key: releaseCacheKey(desk.id),
    etag: 'W/"r1"',
    lastModified: null,
    fetchedAt: AT,
    status: 200,
    body: Buffer.from(
      JSON.stringify({
        tag: 'v2.3.0',
        publishedAt: '2026-10-01T09:00:00Z',
        installerAssets: ['Kestrel-2.3.0-universal.dmg', 'Kestrel-Setup-2.3.0.exe'],
      }),
    ),
  })
  const advisory = repos.advisories.upsert({
    advisoryKey: 'GHSA-desk-0000-0001',
    ghsaId: 'GHSA-desk-0000-0001',
    ecosystem: 'npm',
    packageName: 'example-parser',
    severity: 'critical',
  })
  const due = repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: advisory.id,
      repoId: desk.id,
      scope: 'runtime',
      reportedBy: ['osv'],
      releaseTag: 'v2.3.0',
      fixedOnDefaultBranch: true,
    },
    AT,
  ).finding
  const note = repos.findings.observe(
    { kind: 'coverage_note', coverageNoteType: 'release_lockfile_missing', repoId: desk.id },
    AT,
  ).finding
  return { ...api, desk, due, note }
}

describe('GET /api/repos/:id release', () => {
  it('shows the latest release, its installers and what the tag scan found', async () => {
    const { call, desk } = world()
    const detail = repoDetailSchema.parse((await call('GET', `/repos/${desk.id}`)).json)
    expect(detail.release).toEqual({
      tier: 'auto',
      status: 'released',
      latestTag: 'v2.3.0',
      latestAt: '2026-10-01T09:00:00.000Z',
      installers: true,
      installerAssets: ['Kestrel-2.3.0-universal.dmg', 'Kestrel-Setup-2.3.0.exe'],
      checkedAt: AT.toISOString(),
      openFindings: 1,
      fixedOnDefaultBranch: 1,
      lockfileMissing: true,
    })
  })

  it('says not checked for a repo the release check has not reached', async () => {
    const { call, repos } = world()
    const fresh = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-lib' })
    const detail = repoDetailSchema.parse((await call('GET', `/repos/${fresh.id}`)).json)
    expect(detail.release).toMatchObject({
      status: 'not_checked',
      latestTag: null,
      installerAssets: [],
      openFindings: 0,
    })
  })
})

describe('PUT /api/repos/:id/release-tier', () => {
  it('turns the tier off and back to auto, asking GitHub again on the next scan', async () => {
    const { call, desk, repos } = world()
    const off = await call('PUT', `/repos/${desk.id}/release-tier`, { tier: 'off' })
    expect(off.status).toBe(200)
    expect(repoDetailSchema.parse(off.json).release).toMatchObject({
      tier: 'off',
      status: 'turned_off',
      checkedAt: null,
    })
    expect(repos.repos.get(desk.id)?.releaseTier).toBe('off')

    const on = await call('PUT', `/repos/${desk.id}/release-tier`, { tier: 'on' })
    expect(repoDetailSchema.parse(on.json).release).toMatchObject({
      tier: 'on',
      status: 'released',
    })
  })

  it('rejects an unknown mode and an unknown repo', async () => {
    const { call, desk } = world()
    expect((await call('PUT', `/repos/${desk.id}/release-tier`, { tier: 'always' })).status).toBe(
      400,
    )
    expect((await call('PUT', '/repos/9999/release-tier', { tier: 'on' })).status).toBe(404)
  })
})

describe('GET /api/findings release rows', () => {
  it('serves the release tag, the patched release signal and the note type', async () => {
    const { call, due, note } = world()
    const { items } = findingsResponseSchema.parse(
      (await call('GET', '/findings?release=true')).json,
    )
    expect(items.find((i) => i.id === due.id)).toMatchObject({
      releaseTag: 'v2.3.0',
      fixedOnDefaultBranch: true,
      tier: 'released',
    })
    const all = findingsResponseSchema.parse((await call('GET', '/findings')).json).items
    expect(all.find((i) => i.id === note.id)).toMatchObject({
      kind: 'coverage_note',
      coverageNote: 'release_lockfile_missing',
      tier: 'coverage',
    })
  })
})
