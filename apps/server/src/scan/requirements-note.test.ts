import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import { repoCoverageNoteFindingKey, type Repositories } from '../repository/index.js'
import { applyRequirementsNotes } from './blind-spots.js'
import {
  scanLockfilesAt,
  type OsvRepoResult,
  type RepoScan,
  type SourceOutcome,
} from './collect.js'
import { indexDeployments } from './deployments.js'
import type { ScanSources } from './sources.js'

// Every repo and package here is fictional.

let repos: Repositories
let handle: DatabaseHandle
let repo: RepoRow

const t0 = new Date('2026-11-06T10:00:00Z')
const t1 = new Date('2026-11-07T10:00:00Z')
const t2 = new Date('2026-11-08T10:00:00Z')

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor-api' })
  const coolify = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  })
  repos.deployments.upsert(
    {
      sourceId: coolify.id,
      externalId: 'app-1',
      kind: 'application',
      name: 'harbor-api',
      domains: ['https://harbor.example.dev'],
      reach: 'public',
      server: 'edge-1',
      status: 'running:healthy',
      gitRepository: 'kestrel-co/harbor-api',
      repoId: repo.id,
    },
    t0,
  )
})
afterEach(() => handle.close())

const note = () =>
  repos.findings.getByKey(repoCoverageNoteFindingKey('requirements_unpinned', repo.id))
const detailsOf = (id: number) =>
  repos.findings
    .listEvents(id)
    .filter((e) => e.type === 'details')
    .map((e) => e.data)

function scanOf(osv: SourceOutcome<OsvRepoResult>): ReadonlyMap<number, RepoScan> {
  const scan: RepoScan = {
    repo,
    deployed: true,
    health: { status: 'skipped', reason: 'test' },
    alerts: { status: 'skipped', reason: 'test' },
    osv,
  }
  return new Map([[repo.id, scan]])
}

const ok = (unpinned: { path: string; count: number }[]): SourceOutcome<OsvRepoResult> => ({
  status: 'ok',
  value: { matches: [], lockfiles: ['requirements.txt'], unparseable: [], unpinned },
})

function apply(scans: ReadonlyMap<number, RepoScan>, now: Date) {
  return applyRequirementsNotes(repos, indexDeployments(repos), scans, now)
}

describe('applyRequirementsNotes', () => {
  it('opens a repo note with the files and the number of lines', () => {
    const changes = apply(
      scanOf(
        ok([
          { path: 'requirements.txt', count: 2 },
          { path: 'worker/requirements.txt', count: 1 },
        ]),
      ),
      t0,
    )
    const opened = note()!
    expect(changes).toEqual([{ findingId: opened.id, change: 'opened' }])
    expect(opened).toMatchObject({ kind: 'coverage_note', state: 'open', repoId: repo.id })
    expect(detailsOf(opened.id)).toEqual([
      {
        files: [
          { path: 'requirements.txt', count: 2 },
          { path: 'worker/requirements.txt', count: 1 },
        ],
        total: 3,
      },
    ])
  })

  it('leaves an unchanged note alone and writes details again only when they change', () => {
    const files = [{ path: 'requirements.txt', count: 2 }]
    apply(scanOf(ok(files)), t0)
    expect(apply(scanOf(ok(files)), t1)).toEqual([])
    expect(detailsOf(note()!.id)).toHaveLength(1)
    expect(apply(scanOf(ok([{ path: 'requirements.txt', count: 3 }])), t2)).toEqual([])
    expect(detailsOf(note()!.id)).toHaveLength(2)
  })

  it('resolves once every line is pinned and reopens when one is not', () => {
    apply(scanOf(ok([{ path: 'requirements.txt', count: 1 }])), t0)
    const id = note()!.id
    expect(apply(scanOf(ok([])), t1)).toEqual([{ findingId: id, change: 'fixed' }])
    expect(note()!.state).toBe('fixed')
    expect(apply(scanOf(ok([])), t2)).toEqual([])
    expect(apply(scanOf(ok([{ path: 'requirements.txt', count: 1 }])), t2)).toEqual([
      { findingId: id, change: 'reopened' },
    ])
  })

  it('resolves when OSV is switched off, and leaves the note alone when the read failed', () => {
    apply(scanOf(ok([{ path: 'requirements.txt', count: 1 }])), t0)
    expect(apply(scanOf({ status: 'error', error: 'GitHub answered 502' }), t1)).toEqual([])
    expect(note()!.state).toBe('open')
    apply(scanOf({ status: 'skipped', reason: 'OSV is switched off' }), t2)
    expect(note()!.state).toBe('fixed')
  })

  it('resolves for a repo nothing deploys any more', () => {
    apply(scanOf(ok([{ path: 'requirements.txt', count: 1 }])), t0)
    repos.deployments.list().forEach((d) => repos.deployments.remove(d.id))
    apply(new Map(), t1)
    expect(note()!.state).toBe('fixed')
  })
})

describe('scanLockfilesAt', () => {
  it('counts the unpinned lines of each requirements file', async () => {
    const sources = {
      osv: {
        client: {
          queryBatch: () => Promise.resolve([]),
          getVulnerabilities: () => Promise.resolve([]),
        },
      },
      fetchLockfiles: () =>
        Promise.resolve([
          { path: 'requirements.txt', text: 'flask==3.0.0\nrequests>=2\nrich\n' },
          { path: 'worker/requirements.txt', text: 'celery==5.4.0\n' },
        ]),
    } as unknown as ScanSources
    const result = await scanLockfilesAt(sources, sources.osv!, repo, 'main', null)
    expect(result.unpinned).toEqual([{ path: 'requirements.txt', count: 2 }])
  })
})
