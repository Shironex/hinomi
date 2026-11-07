import { describe, expect, it } from 'vitest'
import {
  LATEST_RETRY_MS,
  LATEST_TTL_MS,
  fetchLatestFixWorkflow,
  releaseLatestSource,
} from './latest.js'
import { fakeGithub, type FakeRoute } from './testing.js'

const SHA = 'b'.repeat(40)
const FALLBACK = { sha: 'a'.repeat(40), version: 'v0.2.0' }

function routes(overrides: { tag?: string; sha?: string; file?: boolean } = {}): FakeRoute[] {
  return [
    {
      path: '/repos/Shironex/hinomi/releases/latest',
      reply: { body: { tag_name: overrides.tag ?? 'v0.3.0' } },
    },
    {
      path: `/repos/Shironex/hinomi/commits/${overrides.tag ?? 'v0.3.0'}`,
      reply: { body: { sha: overrides.sha ?? SHA } },
    },
    {
      path: `/repos/Shironex/hinomi/contents/.github/workflows/fix.yml?ref=${overrides.sha ?? SHA}`,
      reply: overrides.file === false ? { status: 404 } : { body: { type: 'file' } },
    },
  ]
}

describe('fetchLatestFixWorkflow', () => {
  it('reads the latest release tag, its commit and checks fix.yml exists there', async () => {
    const gh = fakeGithub(routes())
    expect(await fetchLatestFixWorkflow(gh.fetch)).toEqual({ sha: SHA, version: 'v0.3.0' })
  })

  it('answers null for a release without the reusable workflow', async () => {
    expect(await fetchLatestFixWorkflow(fakeGithub(routes({ file: false })).fetch)).toBeNull()
  })

  it('answers null for an odd tag or commit', async () => {
    expect(await fetchLatestFixWorkflow(fakeGithub(routes({ tag: 'main' })).fetch)).toBeNull()
    expect(await fetchLatestFixWorkflow(fakeGithub(routes({ sha: 'nope' })).fetch)).toBeNull()
    expect(await fetchLatestFixWorkflow(fakeGithub([]).fetch)).toBeNull()
  })
})

describe('releaseLatestSource', () => {
  it('caches a found release for hours', async () => {
    let now = 1_000
    const gh = fakeGithub(routes())
    const source = releaseLatestSource({ fetch: gh.fetch, now: () => now, fallback: FALLBACK })
    const [a, b] = await Promise.all([source.get(), source.get()])
    expect(a).toEqual({ sha: SHA, version: 'v0.3.0' })
    expect(b).toEqual(a)
    expect(gh.requests).toHaveLength(3)
    now += LATEST_TTL_MS - 1
    await source.get()
    expect(gh.requests).toHaveLength(3)
    now += 2
    await source.get()
    expect(gh.requests).toHaveLength(6)
  })

  it('falls back to the constant and retries sooner when the lookup fails', async () => {
    let now = 1_000
    const failing: typeof fetch = () => Promise.reject(new Error('offline'))
    const source = releaseLatestSource({ fetch: failing, now: () => now, fallback: FALLBACK })
    expect(await source.get()).toEqual(FALLBACK)
    now += LATEST_RETRY_MS + 1
    expect(await source.get()).toEqual(FALLBACK)
    const none = releaseLatestSource({ fetch: failing, fallback: null })
    expect(await none.get()).toBeNull()
  })
})
