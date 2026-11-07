import { describe, expect, it } from 'vitest'
import { createGithubClient } from './client.js'
import { fetchLatestRelease } from './releases.js'
import { scriptedFetch, type CannedResponse } from './testing.js'

const BASE = 'https://github.example.dev'

function setup(responses: CannedResponse[]) {
  const { fetch, requests } = scriptedFetch(responses)
  return {
    requests,
    client: createGithubClient({ token: 'test-token', baseUrl: BASE, fetch, maxRetries: 0 }),
  }
}

const release = {
  tag_name: 'v2.3.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T09:00:00Z',
  assets: [{ name: 'Kestrel-2.3.0-universal.dmg' }, { name: 'Kestrel-Setup-2.3.0.exe' }],
}

describe('fetchLatestRelease', () => {
  it('reads the tag, the date, the asset names and the etag', async () => {
    const { client, requests } = setup([{ body: release, headers: { etag: 'W/"r1"' } }])
    expect(await fetchLatestRelease(client, 'kestrel-co', 'kestrel-desk', null)).toEqual({
      modified: true,
      etag: 'W/"r1"',
      value: {
        tag: 'v2.3.0',
        publishedAt: '2026-10-01T09:00:00Z',
        assetNames: ['Kestrel-2.3.0-universal.dmg', 'Kestrel-Setup-2.3.0.exe'],
      },
    })
    expect(requests[0]).toMatchObject({
      url: `${BASE}/repos/kestrel-co/kestrel-desk/releases/latest`,
      ifNoneMatch: null,
    })
  })

  it('sends the last etag and reports not modified on 304', async () => {
    const { client, requests } = setup([{ status: 304, headers: { etag: 'W/"r1"' } }])
    expect(await fetchLatestRelease(client, 'kestrel-co', 'kestrel-desk', 'W/"r1"')).toEqual({
      modified: false,
      etag: 'W/"r1"',
    })
    expect(requests[0]?.ifNoneMatch).toBe('W/"r1"')
  })

  it('answers no release on 404', async () => {
    const { client } = setup([{ status: 404, body: { message: 'Not Found' } }])
    expect(await fetchLatestRelease(client, 'kestrel-co', 'kestrel-lib', null)).toEqual({
      modified: true,
      etag: null,
      value: null,
    })
  })

  it('ignores a draft or a prerelease if one comes back anyway', async () => {
    const { client } = setup([{ body: { ...release, prerelease: true } }])
    const read = await fetchLatestRelease(client, 'kestrel-co', 'kestrel-desk', null)
    expect(read).toMatchObject({ modified: true, value: null })
  })

  it('treats missing assets as none', async () => {
    const { client } = setup([{ body: { tag_name: 'v1.0.0' } }])
    const read = await fetchLatestRelease(client, 'kestrel-co', 'kestrel-lib', null)
    expect(read).toMatchObject({ value: { tag: 'v1.0.0', publishedAt: null, assetNames: [] } })
  })
})
