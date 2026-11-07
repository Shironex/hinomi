import type { AccountRepo, OsvQuery, OsvVulnerability } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import {
  advisoryFindingKey,
  releaseAdvisoryFindingKey,
  repoCoverageNoteFindingKey,
  type Repositories,
} from '../repository/index.js'
import type { GithubRelease } from '../sources/github/index.js'
import type { FetchedLockfile, OsvClient } from '../sources/osv/index.js'
import { tierOf } from './rank.js'
import { isReleaseCheckDue, releaseCacheKey, releaseStatus } from './releases.js'
import { runRepoScan, runScan } from './run.js'
import type { GithubScanSource, ScanSources } from './sources.js'
import { listRankedFindings } from './views.js'

// A fictional account, kestrel-co:
//   kestrel-desk  desktop app, release v2.3.0 with a dmg and an exe: released
//   kestrel-lib   library, release v1.4.0 with only a source archive: not released
//   kestrel-beta  only a prerelease (GitHub's latest endpoint answers 404): no release
//   kestrel-cli   release v0.9.0 with a linux archive and no lockfile at the tag
//   harbor        deployed as harbor-web, also ships installers: keeps its deploy tiers

const AT = new Date('2026-11-08T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const GHSA = 'GHSA-desk-0000-0001'

const RELEASES: Record<string, GithubRelease | null> = {
  'kestrel-desk': {
    tag: 'v2.3.0',
    publishedAt: '2026-10-01T09:00:00Z',
    assetNames: ['Kestrel-2.3.0-universal.dmg', 'Kestrel-Setup-2.3.0.exe', 'latest.yml'],
  },
  'kestrel-lib': {
    tag: 'v1.4.0',
    publishedAt: '2026-09-15T09:00:00Z',
    assetNames: ['kestrel-lib-1.4.0.tar.gz'],
  },
  'kestrel-beta': null,
  'kestrel-cli': {
    tag: 'v0.9.0',
    publishedAt: '2026-10-20T09:00:00Z',
    assetNames: ['kestrel-cli_0.9.0_linux_amd64.tar.gz'],
  },
  harbor: {
    tag: 'v5.0.0',
    publishedAt: '2026-10-02T09:00:00Z',
    assetNames: ['Harbor-5.0.0.dmg'],
  },
}

function pnpmLock(version: string): string {
  return `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      example-parser:
        specifier: ^1.2.0
        version: ${version}

snapshots:

  example-parser@${version}: {}
`
}

const VULN: OsvVulnerability = {
  id: GHSA,
  summary: 'Fictional parser issue',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    {
      package: { name: 'example-parser', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.5' }] }],
    },
  ],
}

interface World {
  releases: Record<string, GithubRelease | null>
  /** Lockfile versions of example-parser per `repo@ref`; absent means no lockfile there. */
  lockfiles: Record<string, string>
  /** Repos whose release read fails. */
  failRelease: Set<string>
  releaseCalls: { repo: string; etag: string | null }[]
  lockfileReads: string[]
}

let handle: DatabaseHandle
let repos: Repositories
let world: World
let githubSourceId: number

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  githubSourceId = repos.sources.create({
    kind: 'github',
    name: 'kestrel-co',
    token: 'github-token-fictional',
  }).id
  const coolify = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  })
  const harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  repos.deployments.upsert(
    {
      sourceId: coolify.id,
      externalId: 'app-1',
      kind: 'application',
      name: 'harbor-web',
      domains: ['https://harbor.example.dev'],
      reach: 'public',
      server: 'edge-1',
      status: 'running:healthy',
      gitRepository: 'kestrel-co/harbor',
      repoId: harbor.id,
    },
    AT,
  )
  world = {
    releases: { ...RELEASES },
    lockfiles: {
      'kestrel-desk@v2.3.0': '1.2.0',
      'kestrel-desk@main': '1.2.0',
      'kestrel-lib@v1.4.0': '1.2.0',
      'kestrel-lib@main': '1.2.0',
      'harbor@main': '1.2.5',
    },
    failRelease: new Set(),
    releaseCalls: [],
    lockfileReads: [],
  }
})

afterEach(() => handle.close())

function github(): GithubScanSource {
  return {
    sourceId: githubSourceId,
    name: 'kestrel-co',
    fetchRepoHealth: (owner, name) =>
      Promise.resolve({
        owner,
        name,
        archived: false,
        defaultBranch: 'main',
        visibility: 'private',
        alertsEnabled: true,
        pushedAt: null,
      }),
    fetchDependabotAlerts: () => Promise.resolve({ advisories: [], alerts: [], dismissed: [] }),
    listAccountRepos: (): Promise<AccountRepo[]> =>
      Promise.resolve(
        Object.keys(RELEASES).map((name) => ({
          owner: 'kestrel-co',
          name,
          archived: false,
          fork: false,
          defaultBranch: 'main',
          visibility: 'private',
          pushedAt: null,
        })),
      ),
    fetchLatestRelease: (_owner, name, etag) => {
      world.releaseCalls.push({ repo: name, etag })
      if (world.failRelease.has(name)) return Promise.reject(new Error('GitHub answered 502'))
      const value = world.releases[name] ?? null
      const current = value ? `W/"${name}-${value.tag}"` : null
      if (etag !== null && etag === current) return Promise.resolve({ modified: false, etag })
      return Promise.resolve({ modified: true, etag: current, value })
    },
  }
}

function osvClient(): OsvClient {
  const affected = (q: OsvQuery) =>
    q.package.name === 'example-parser' && q.version !== undefined && q.version < '1.2.5'
  return {
    queryBatch: (queries) => Promise.resolve(queries.map((q) => (affected(q) ? [GHSA] : []))),
    getVulnerability: () => Promise.resolve(VULN),
    getVulnerabilities: (ids) => Promise.resolve(ids.map(() => VULN)),
    queryPackage: () => Promise.resolve([]),
  }
}

function sources(osvOn = true): ScanSources {
  return {
    coolify: [],
    github: [github()],
    osv: osvOn ? { sourceId: null, client: osvClient() } : null,
    settings: { osvEnabled: osvOn, includeAccountRepos: true, imageScan: 'off' },
    fetchLockfiles: (_owner, name, ref): Promise<FetchedLockfile[]> => {
      world.lockfileReads.push(`${name}@${ref}`)
      const version = world.lockfiles[`${name}@${ref}`]
      return Promise.resolve(
        version === undefined ? [] : [{ path: 'pnpm-lock.yaml', text: pnpmLock(version) }],
      )
    },
  }
}

const scan = (at = AT, osvOn = true) =>
  runScan({ repositories: repos }, sources(osvOn), { now: () => at })

const repo = (name: string) => repos.repos.getByName('kestrel-co', name)!
const advisoryId = () => repos.advisories.findByAnyId(GHSA)[0]!.id
const releaseRow = (name: string) =>
  repos.findings.getByKey(releaseAdvisoryFindingKey(advisoryId(), repo(name).id))
const mainRow = (name: string) =>
  repos.findings.getByKey(advisoryFindingKey(advisoryId(), repo(name).id))
const lockfileNote = (name: string) =>
  repos.findings.getByKey(repoCoverageNoteFindingKey('release_lockfile_missing', repo(name).id))

describe('desktop release tier', () => {
  it('scans the latest tag of a repo with installers and ranks it in the released tier', async () => {
    const summary = await scan()
    expect(summary.status).toBe('succeeded')

    const desk = repo('kestrel-desk')
    expect(desk).toMatchObject({
      latestReleaseTag: 'v2.3.0',
      latestReleaseAt: new Date('2026-10-01T09:00:00Z'),
      releaseInstallers: true,
      releaseCheckedAt: AT,
    })
    expect(releaseStatus(desk, false)).toBe('released')
    expect(world.lockfileReads).toContain('kestrel-desk@v2.3.0')

    const row = releaseRow('kestrel-desk')!
    expect(row).toMatchObject({
      kind: 'advisory',
      state: 'open',
      releaseTag: 'v2.3.0',
      scope: 'runtime',
      installedVersion: '1.2.0',
      reportedBy: ['osv'],
      fixedOnDefaultBranch: false,
    })
    // The default branch row is a separate finding.
    expect(mainRow('kestrel-desk')?.id).not.toBe(row.id)

    const ranked = listRankedFindings(repos).find((r) => r.finding.id === row.id)!
    expect(ranked.reach).toBe('released')
    expect(tierOf(ranked)).toBe('released')
    // Weighs like internal: reach 1 * 10 + runtime 5 + critical 4.
    expect(Math.floor(ranked.rank)).toBe(19)
    expect(summary.sourceResults.github?.counts).toMatchObject({ releases: 4 })
    expect(summary.sourceResults.osv?.counts).toMatchObject({ releaseTags: 2 })
  })

  it('leaves out a release with only a source archive, and a repo with only a prerelease', async () => {
    await scan()
    expect(repo('kestrel-lib')).toMatchObject({
      latestReleaseTag: 'v1.4.0',
      releaseInstallers: false,
    })
    expect(releaseStatus(repo('kestrel-lib'), false)).toBe('no_installers')
    expect(releaseRow('kestrel-lib')).toBeUndefined()
    expect(world.lockfileReads).not.toContain('kestrel-lib@v1.4.0')

    expect(repo('kestrel-beta')).toMatchObject({ latestReleaseTag: null, releaseCheckedAt: AT })
    expect(releaseStatus(repo('kestrel-beta'), false)).toBe('no_release')
  })

  it('never puts a deployed repo in the tier and never asks for its release', async () => {
    await scan()
    expect(world.releaseCalls.map((c) => c.repo)).not.toContain('harbor')
    expect(repo('harbor').latestReleaseTag).toBeNull()
    expect(releaseStatus(repo('harbor'), true)).toBe('deployed')
  })

  it('resolves the release rows of a repo that gets a deployment', async () => {
    await scan()
    const id = releaseRow('kestrel-desk')!.id
    const coolify = repos.sources.listByKind('coolify')[0]!
    repos.deployments.upsert(
      {
        sourceId: coolify.id,
        externalId: 'app-2',
        kind: 'application',
        name: 'kestrel-desk-web',
        domains: [],
        reach: 'internal',
        server: 'edge-1',
        status: 'running:healthy',
        gitRepository: 'kestrel-co/kestrel-desk',
        repoId: repo('kestrel-desk').id,
      },
      AT,
    )
    await scan(new Date(AT.getTime() + 60_000))
    expect(repos.findings.get(id)?.state).toBe('fixed')
    expect(repos.findings.listEvents(id)[0]).toMatchObject({
      type: 'fixed',
      data: { reason: 'deployed', release: true },
    })
  })

  it('checks the latest release once a day with its etag', async () => {
    await scan()
    const calls = () => world.releaseCalls.filter((c) => c.repo === 'kestrel-desk')
    expect(calls()).toEqual([{ repo: 'kestrel-desk', etag: null }])
    expect(repos.httpCache.get(releaseCacheKey(repo('kestrel-desk').id))?.etag).toBe(
      'W/"kestrel-desk-v2.3.0"',
    )

    // Within the day: no new request, but the tag is scanned again (advisories change daily).
    world.lockfileReads = []
    await scan(new Date(AT.getTime() + DAY / 2))
    expect(calls()).toHaveLength(1)
    expect(world.lockfileReads).toContain('kestrel-desk@v2.3.0')

    // A day later: asked with the stored etag; the 304 keeps everything and moves the check time.
    const later = new Date(AT.getTime() + DAY)
    expect(isReleaseCheckDue(repo('kestrel-desk'), later)).toBe(true)
    await scan(later)
    expect(calls()[1]).toEqual({ repo: 'kestrel-desk', etag: 'W/"kestrel-desk-v2.3.0"' })
    expect(repo('kestrel-desk')).toMatchObject({
      latestReleaseTag: 'v2.3.0',
      releaseInstallers: true,
      releaseCheckedAt: later,
    })
  })

  it('follows a new tag: the row moves to it and is fixed when the tag no longer has it', async () => {
    await scan()
    const id = releaseRow('kestrel-desk')!.id
    world.releases['kestrel-desk'] = {
      tag: 'v2.4.0',
      publishedAt: '2026-11-09T09:00:00Z',
      assetNames: ['Kestrel-2.4.0-universal.dmg'],
    }
    world.lockfiles['kestrel-desk@v2.4.0'] = '1.2.5'
    await scan(new Date(AT.getTime() + DAY))
    expect(repo('kestrel-desk').latestReleaseTag).toBe('v2.4.0')
    expect(repos.findings.get(id)).toMatchObject({ state: 'fixed' })
    expect(repos.findings.listEvents(id)[0]).toMatchObject({
      type: 'fixed',
      data: { releaseTag: 'v2.4.0', coveredBy: ['osv'] },
    })
  })

  it('turns the tier on for a repo the heuristic misses, and off for one it flags', async () => {
    const lib = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-lib' })
    const desk = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-desk' })
    repos.repos.setReleaseTier(lib.id, 'on')
    repos.repos.setReleaseTier(desk.id, 'off')
    await scan()
    expect(releaseStatus(repo('kestrel-lib'), false)).toBe('released')
    expect(releaseRow('kestrel-lib')).toMatchObject({ state: 'open', releaseTag: 'v1.4.0' })
    // Off: not even asked.
    expect(world.releaseCalls.map((c) => c.repo)).not.toContain('kestrel-desk')
    expect(releaseStatus(repo('kestrel-desk'), false)).toBe('turned_off')
  })

  it('resolves the release rows when the tier is turned off, and asks again when turned back on', async () => {
    await scan()
    const id = releaseRow('kestrel-desk')!.id
    const later = new Date(AT.getTime() + 60_000)
    repos.repos.setReleaseTier(repo('kestrel-desk').id, 'off')
    await scan(later)
    expect(repos.findings.get(id)?.state).toBe('fixed')
    expect(repos.findings.listEvents(id)[0]?.data).toEqual({ reason: 'turned_off', release: true })

    repos.repos.setReleaseTier(repo('kestrel-desk').id, 'auto')
    expect(repo('kestrel-desk').releaseCheckedAt).toBeNull()
    const again = new Date(AT.getTime() + 120_000)
    await scan(again)
    expect(repo('kestrel-desk').releaseCheckedAt).toEqual(again)
    expect(repos.findings.get(id)?.state).toBe('open')
  })

  it('notes a release tag without a lockfile and resolves the note once one appears', async () => {
    await scan()
    expect(releaseStatus(repo('kestrel-cli'), false)).toBe('released')
    const note = lockfileNote('kestrel-cli')!
    expect(note).toMatchObject({
      kind: 'coverage_note',
      state: 'open',
      repoId: repo('kestrel-cli').id,
    })
    const ranked = listRankedFindings(repos).find((r) => r.finding.id === note.id)!
    expect(tierOf(ranked)).toBe('coverage')
    expect(lockfileNote('kestrel-desk')).toBeUndefined()

    world.lockfiles['kestrel-cli@v0.9.0'] = '1.2.5'
    await scan(new Date(AT.getTime() + 60_000))
    expect(lockfileNote('kestrel-cli')?.state).toBe('fixed')
  })

  it('says a patched release is due when the default branch no longer has the advisory', async () => {
    await scan()
    expect(releaseRow('kestrel-desk')?.fixedOnDefaultBranch).toBe(false)

    // The default branch moves to the patched version; the release still ships the old one.
    world.lockfiles['kestrel-desk@main'] = '1.2.5'
    await scan(new Date(AT.getTime() + 60_000))
    expect(mainRow('kestrel-desk')?.state).toBe('fixed')
    const row = releaseRow('kestrel-desk')!
    expect(row).toMatchObject({ state: 'open', fixedOnDefaultBranch: true, releaseTag: 'v2.3.0' })
    expect(repos.findings.listEvents(row.id).map((e) => e.type)).toContain(
      'fixed_on_default_branch',
    )

    // The default branch rescan (fix verification) never touches the release row.
    const rescan = await runRepoScan({ repositories: repos }, sources(), repo('kestrel-desk').id, {
      now: () => new Date(AT.getTime() + 120_000),
    })
    expect(rescan.status).toBe('succeeded')
    expect(repos.findings.get(row.id)?.state).toBe('open')
  })

  it('keeps the rows and records the error when the release read fails', async () => {
    await scan()
    const id = releaseRow('kestrel-desk')!.id
    world.failRelease.add('kestrel-desk')
    const summary = await scan(new Date(AT.getTime() + DAY))
    expect(summary.errors).toContainEqual(
      expect.objectContaining({
        source: 'github',
        subject: 'kestrel-co/kestrel-desk latest release',
      }),
    )
    expect(repo('kestrel-desk').latestReleaseTag).toBe('v2.3.0')
    expect(repos.findings.get(id)?.state).toBe('open')
  })

  it('reads releases but leaves the rows alone while OSV is off', async () => {
    await scan()
    const id = releaseRow('kestrel-desk')!.id
    world.lockfileReads = []
    await scan(new Date(AT.getTime() + 60_000), false)
    expect(world.lockfileReads).toEqual([])
    expect(repos.findings.get(id)?.state).toBe('open')
  })
})
