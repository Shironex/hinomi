import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTestRepositories } from '../db/test-db.js'
import { scriptedFetch } from '../sources/github/testing.js'
import { buildScanSources } from './sources.js'
import { nowMs } from '@hinomi/shared'

// A throwaway key made for this run only.
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

describe('scan sources with a GitHub App', () => {
  it('signs in as the installation and lists its repos', async () => {
    const { repos } = createTestRepositories()
    repos.sources.create({
      kind: 'github',
      name: 'kestrel-co',
      auth: 'github_app',
      appId: '1234',
      installationId: '4242',
      token: PRIVATE_KEY,
    })
    const { fetch, requests } = scriptedFetch([
      {
        status: 201,
        body: { token: 'ghs_scan', expires_at: new Date(nowMs() + 3_600_000).toISOString() },
      },
      {
        body: {
          total_count: 1,
          repositories: [{ name: 'lantern-api', owner: { login: 'kestrel-co' }, archived: false }],
        },
      },
    ])
    const sources = buildScanSources(repos, { fetch })
    const list = await sources.github?.listAccountRepos()
    expect(list?.map((r) => `${r.owner}/${r.name}`)).toEqual(['kestrel-co/lantern-api'])
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.github.com/app/installations/4242/access_tokens',
      'https://api.github.com/installation/repositories?per_page=100',
    ])
    expect(requests[1]?.authorization).toBe('Bearer ghs_scan')
  })
})
