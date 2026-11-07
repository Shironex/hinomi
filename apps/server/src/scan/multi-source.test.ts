import type { AccountRepo, DependabotAlertsResult, RepoHealth } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { GithubError } from '../sources/github/index.js'
import { runRepoScan, runScan } from './run.js'
import type { GithubScanSource, ScanSources } from './sources.js'

// Two GitHub sources of a fictional company: kestrel-co (an org token) and kestrel-labs (a
// GitHub App). Each sees some repos; `shared-ui` is seen by both.

const AT = new Date('2026-11-07T06:00:00Z')

interface Sight {
  /** What GET /vulnerability-alerts tells this source: on, off, or no permission. */
  alerts: boolean | null
}

interface FakeSource {
  github: GithubScanSource
  sees: Map<string, Sight>
  /** `health owner/name` and `alerts owner/name`, in order. */
  calls: string[]
  /** Throws this instead of answering, for every repo. */
  failWith: Error | null
}

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  repos.settings.set('scan.includeAccountRepos', true)
})
afterEach(() => handle.close())

function alertsFor(owner: string, name: string): DependabotAlertsResult {
  const ghsaId = 'GHSA-ms00-0000-0001'
  return {
    advisories: [
      {
        ghsaId,
        cveIds: [],
        package: 'example-parser',
        ecosystem: 'npm',
        severity: 'high',
        cvss: null,
        summary: 'Fictional issue in example-parser',
        vulnerableRange: '< 1.2.5',
        firstPatched: '1.2.5',
        publishedAt: '2026-09-01T00:00:00Z',
      },
    ],
    alerts: [
      {
        owner,
        repo: name,
        alertNumber: 1,
        ghsaId,
        package: 'example-parser',
        ecosystem: 'npm',
        scope: 'runtime',
        manifestPath: 'package-lock.json',
        createdAt: '2026-10-01T00:00:00Z',
        dismissedAt: null,
      },
    ],
    dismissed: [],
  }
}

/** A GitHub source row and a fake client that sees the given repos of kestrel-co. */
function source(name: string, sees: Record<string, Sight>): FakeSource {
  const row = repos.sources.create({ kind: 'github', name, token: `${name}-token` })
  const state: Omit<FakeSource, 'github'> = {
    sees: new Map(Object.entries(sees)),
    calls: [],
    failWith: null,
  }
  const fake = state as FakeSource
  const sight = (repo: string): Sight => {
    if (fake.failWith) throw fake.failWith
    const found = fake.sees.get(repo)
    if (!found) throw new GithubError('not_found', `${name} cannot see ${repo}`, { status: 404 })
    return found
  }
  fake.github = {
    sourceId: row.id,
    name,
    fetchRepoHealth: (owner, repo): Promise<RepoHealth> => {
      fake.calls.push(`health ${owner}/${repo}`)
      try {
        const { alerts } = sight(repo)
        return Promise.resolve({
          owner,
          name: repo,
          archived: false,
          defaultBranch: 'main',
          visibility: 'private',
          alertsEnabled: alerts,
          pushedAt: null,
        })
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
    fetchDependabotAlerts: (owner, repo) => {
      fake.calls.push(`alerts ${owner}/${repo}`)
      return Promise.resolve(alertsFor(owner, repo))
    },
    fetchLatestRelease: () => Promise.resolve({ modified: true, etag: null, value: null }),
    listAccountRepos: (): Promise<AccountRepo[]> => {
      if (fake.failWith) return Promise.reject(fake.failWith)
      return Promise.resolve(
        [...fake.sees.keys()].map((repo) => ({
          owner: 'kestrel-co',
          name: repo,
          archived: false,
          fork: false,
          defaultBranch: 'main',
          visibility: 'private',
          pushedAt: null,
        })),
      )
    },
  }
  return fake
}

function scanSources(...github: FakeSource[]): ScanSources {
  return {
    coolify: [],
    github: github.map((g) => g.github),
    osv: null,
    settings: { osvEnabled: false, includeAccountRepos: true },
    fetchLockfiles: () => Promise.resolve([]),
  }
}

const scan = (...github: FakeSource[]) =>
  runScan({ repositories: repos }, scanSources(...github), { now: () => AT, guards: [] })

const repo = (name: string) => repos.repos.getByName('kestrel-co', name)!
const readerOf = (name: string) => repo(name).sourceId
const findingsOf = (name: string) =>
  repos.findings.list({ repoId: repo(name).id, kind: 'advisory' })

describe('several GitHub sources', () => {
  it('reads repos only one source sees through that source', async () => {
    const co = source('kestrel-co', { 'harbor-web': { alerts: true } })
    const labs = source('kestrel-labs', { 'lantern-api': { alerts: true } })
    const summary = await scan(co, labs)

    expect(summary.status).toBe('succeeded')
    expect(readerOf('harbor-web')).toBe(co.github.sourceId)
    expect(readerOf('lantern-api')).toBe(labs.github.sourceId)
    expect(co.calls).toContain('alerts kestrel-co/harbor-web')
    expect(labs.calls).toContain('alerts kestrel-co/lantern-api')
    // A source is not asked about a repo its own account list leaves out.
    expect(co.calls.some((c) => c.endsWith('lantern-api'))).toBe(false)
    expect(findingsOf('harbor-web')).toHaveLength(1)
    expect(findingsOf('lantern-api')).toHaveLength(1)
    expect(repos.repoSources.repoCounts()).toEqual(
      new Map([
        [co.github.sourceId, 1],
        [labs.github.sourceId, 1],
      ]),
    )
    expect(repos.sources.get(co.github.sourceId)?.lastOkAt).toEqual(AT)
    expect(repos.sources.get(labs.github.sourceId)?.lastOkAt).toEqual(AT)
  })

  it('picks the lowest id source for a repo both see, and reads its alerts once', async () => {
    const co = source('kestrel-co', { 'shared-ui': { alerts: true } })
    const labs = source('kestrel-labs', { 'shared-ui': { alerts: true } })
    await scan(co, labs)

    expect(readerOf('shared-ui')).toBe(co.github.sourceId)
    expect(co.calls).toEqual(['health kestrel-co/shared-ui', 'alerts kestrel-co/shared-ui'])
    expect(labs.calls).toEqual(['health kestrel-co/shared-ui'])
    expect(findingsOf('shared-ui')).toHaveLength(1)
    expect(repos.repoSources.seenBy(repo('shared-ui').id).map((r) => r.sourceId)).toEqual([
      co.github.sourceId,
      labs.github.sourceId,
    ])

    // Scanned again: same reader, still one finding.
    await scan(co, labs)
    expect(readerOf('shared-ui')).toBe(co.github.sourceId)
    expect(findingsOf('shared-ui')).toHaveLength(1)
  })

  it('prefers a source that can read the alerts setting over a lower id one that cannot', async () => {
    const co = source('kestrel-co', { 'shared-ui': { alerts: null } })
    const labs = source('kestrel-labs', { 'shared-ui': { alerts: true } })
    await scan(co, labs)

    expect(readerOf('shared-ui')).toBe(labs.github.sourceId)
    expect(labs.calls).toContain('alerts kestrel-co/shared-ui')
    expect(co.calls).not.toContain('alerts kestrel-co/shared-ui')
    expect(findingsOf('shared-ui')).toHaveLength(1)
  })

  it('reads through a source picked by hand and asks no other', async () => {
    const co = source('kestrel-co', { 'shared-ui': { alerts: true } })
    const labs = source('kestrel-labs', { 'shared-ui': { alerts: true } })
    await scan(co, labs)
    repos.repoSources.setOverride(repo('shared-ui').id, labs.github.sourceId)
    co.calls.length = 0
    labs.calls.length = 0

    await scan(co, labs)
    expect(readerOf('shared-ui')).toBe(labs.github.sourceId)
    expect(co.calls.filter((c) => c.endsWith('shared-ui'))).toEqual([])
    expect(labs.calls).toEqual(['health kestrel-co/shared-ui', 'alerts kestrel-co/shared-ui'])

    // Cleared, the rule applies again.
    repos.repoSources.setOverride(repo('shared-ui').id, null)
    await scan(co, labs)
    expect(readerOf('shared-ui')).toBe(co.github.sourceId)
  })

  it('moves repos of a removed source to another that sees them, or leaves them unread', async () => {
    const co = source('kestrel-co', {
      'shared-ui': { alerts: true },
      'harbor-web': { alerts: true },
    })
    const labs = source('kestrel-labs', { 'shared-ui': { alerts: true } })
    await scan(co, labs)
    const harbor = findingsOf('harbor-web')
    expect(harbor).toHaveLength(1)

    repos.sources.remove(co.github.sourceId)
    expect(readerOf('shared-ui')).toBe(labs.github.sourceId)
    expect(readerOf('harbor-web')).toBeNull()
    // History stays: the finding is still there.
    expect(findingsOf('harbor-web').map((f) => f.id)).toEqual(harbor.map((f) => f.id))
    expect(repos.repoSources.seenBy(repo('harbor-web').id)).toEqual([])
  })

  it('moves repos of a switched off source the same way, and back by the rule once on', async () => {
    const co = source('kestrel-co', { 'shared-ui': { alerts: true } })
    const labs = source('kestrel-labs', { 'shared-ui': { alerts: true } })
    await scan(co, labs)

    repos.sources.update(co.github.sourceId, { enabled: false })
    expect(readerOf('shared-ui')).toBe(labs.github.sourceId)

    repos.sources.update(co.github.sourceId, { enabled: true })
    await scan(co, labs)
    expect(readerOf('shared-ui')).toBe(co.github.sourceId)
  })

  it('keeps the reader through a passing failure, and records it on that source', async () => {
    const co = source('kestrel-co', { 'shared-ui': { alerts: true } })
    const labs = source('kestrel-labs', {})
    await scan(co, labs)
    const id = repo('shared-ui').id

    co.failWith = new GithubError('network', 'socket hang up')
    const rescan = await runRepoScan({ repositories: repos }, scanSources(co, labs), id, {
      now: () => AT,
    })
    expect(rescan.status).toBe('failed')
    expect(readerOf('shared-ui')).toBe(co.github.sourceId)

    const full = await scan(co, labs)
    expect(full.status).not.toBe('succeeded')
    expect(repos.sources.get(co.github.sourceId)?.lastError).toMatch(/socket hang up/)
    expect(readerOf('shared-ui')).toBe(co.github.sourceId)
  })

  it('leaves a repo no source can see without a reader', async () => {
    const co = source('kestrel-co', { 'harbor-web': { alerts: true } })
    await scan(co)
    co.sees.delete('harbor-web')
    const summary = await runRepoScan(
      { repositories: repos },
      scanSources(co),
      repo('harbor-web').id,
      {
        now: () => AT,
      },
    )
    expect(summary.status).toBe('failed')
    expect(readerOf('harbor-web')).toBeNull()
    expect(findingsOf('harbor-web')).toHaveLength(1)
  })
})
