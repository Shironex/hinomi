import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/client.js'
import { createTestRepositories } from '../../db/test-db.js'
import type { Repositories } from '../../repository/index.js'
import { createRepoFileReader } from './repo-files.js'
import type { ScanSources } from '../sources.js'
import type { RepoRow } from '../../db/schema.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
let handle: DatabaseHandle
let repositories: Repositories
let repo: RepoRow

beforeEach(() => {
  ;({ handle, repos: repositories } = createTestRepositories())
  repo = repositories.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
})
afterEach(() => handle.close())

function reader(files: Record<string, string | Error>, sourceId: number | null = 3) {
  const calls: string[] = []
  const sources: Pick<ScanSources, 'github' | 'readRepoFile'> = {
    github: [{ sourceId: 3 } as ScanSources['github'][number]],
    readRepoFile: (_o, _n, path, ref, id) => {
      calls.push(`${id}:${path}@${ref}`)
      const hit = files[path]
      if (hit instanceof Error) return Promise.reject(hit)
      return Promise.resolve(hit ?? null)
    },
  }
  const row: RepoRow = { ...repo, sourceId }
  const make = () =>
    createRepoFileReader({
      sources,
      httpCache: repositories.httpCache,
      scans: new Map(),
      now: () => new Date('2026-11-08T10:00:00Z'),
    })
  return { calls, row, make }
}

describe('repo file reader', () => {
  it('reads through the repo source and caches a sha read across scans', async () => {
    const t = reader({ Dockerfile: 'FROM node:22' })
    expect(await t.make().read(t.row, 'Dockerfile', SHA)).toEqual({
      status: 'ok',
      text: 'FROM node:22',
    })
    // A new scan (new reader) is answered from the http cache.
    expect(await t.make().read(t.row, 'Dockerfile', SHA)).toEqual({
      status: 'ok',
      text: 'FROM node:22',
    })
    expect(t.calls).toEqual([`3:Dockerfile@${SHA}`])
    expect(
      repositories.httpCache.get(`repo-file:kestrel-co/harbor@${SHA}:Dockerfile`)?.status,
    ).toBe(200)
  })

  it('caches a missing file at a sha too', async () => {
    const t = reader({})
    expect(await t.make().read(t.row, 'Dockerfile', SHA)).toEqual({ status: 'missing' })
    expect(await t.make().read(t.row, 'Dockerfile', SHA)).toEqual({ status: 'missing' })
    expect(t.calls).toHaveLength(1)
  })

  it('reads a branch every scan but once within a scan', async () => {
    const t = reader({ Dockerfile: 'FROM node:22' })
    const first = t.make()
    await first.read(t.row, 'Dockerfile', 'main')
    await first.read(t.row, 'Dockerfile', 'main')
    await t.make().read(t.row, 'Dockerfile', 'main')
    expect(t.calls).toHaveLength(2)
    expect(repositories.httpCache.get('repo-file:kestrel-co/harbor@main:Dockerfile')).toBeNull()
  })

  it('reports no source and does not cache a failed read', async () => {
    expect(await reader({}, null).make().read(reader({}, null).row, 'Dockerfile', SHA)).toEqual({
      status: 'no_source',
    })
    const t = reader({ Dockerfile: new Error('GitHub answered 502') })
    expect(await t.make().read(t.row, 'Dockerfile', SHA)).toEqual({
      status: 'error',
      reason: 'GitHub answered 502',
    })
    expect(repositories.httpCache.get(`repo-file:kestrel-co/harbor@${SHA}:Dockerfile`)).toBeNull()
  })
})
