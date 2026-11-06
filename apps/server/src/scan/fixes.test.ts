import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedFixWorld } from '../api/testing.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { groupFixes } from './fixes.js'
import { listRankedFindings } from './views.js'

// Fictional data only: the kestrel-co org from seedFixWorld.

let repos: Repositories
let handle: DatabaseHandle
let world: ReturnType<typeof seedFixWorld>

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  world = seedFixWorld(repos)
})
afterEach(() => handle.close())

const fixes = (filter = {}) => groupFixes(listRankedFindings(repos), filter)
const find = (list: ReturnType<typeof fixes>, pkg: string, target: string | null) =>
  list.find((f) => f.packageName === pkg && f.target === target)

describe('groupFixes', () => {
  it('builds one fix per package and target, exposed criticals first', () => {
    expect(fixes().map((f) => `${f.packageName}@${f.target}`)).toEqual([
      'kestrel-http@2.1.0',
      'pad-ng@null',
      'tiny-glob@1.10.0',
      'hyper-lite@0.14.9',
    ])
  })

  it('targets the highest first patched version, compared as semver and not as text', () => {
    const glob = find(fixes(), 'tiny-glob', '1.10.0')
    expect(glob?.findings).toHaveLength(2)
    expect(glob?.repos[0]?.target).toBe('1.10.0')
  })

  it('reports the target each repo needs and flags mixed targets', () => {
    const http = find(fixes(), 'kestrel-http', '2.1.0')!
    expect(http.mixedTargets).toBe(true)
    expect(http.findings).toHaveLength(5)
    expect(
      Object.fromEntries(http.repos.map((r) => [r.repo.name, [r.target, r.findings.length]])),
    ).toEqual({ storefront: ['2.1.0', 3], ledger: ['2.0.1', 1], docs: ['2.0.4', 1] })
    expect(http.apps.map((a) => a.name)).toEqual(['ledger-api', 'storefront-web'])
    expect(http.bestTier).toBe('exposed')
    expect(http.exposedCritical).toBe(true)
    expect(find(fixes(), 'tiny-glob', '1.10.0')?.mixedTargets).toBe(false)
  })

  it('keeps findings with no patch yet in a separate fix with a null target', () => {
    const pad = find(fixes(), 'pad-ng', null)!
    expect(pad.key).toBe('npm:pad-ng:none')
    expect(pad.mixedTargets).toBe(false)
    expect(pad.repos.map((r) => r.target)).toEqual([null])
    expect(pad.exposedCritical).toBe(true)
  })

  it('does not let a patched-in-lockfile advisory raise the target or count', () => {
    const hyper = find(fixes(), 'hyper-lite', '0.14.9')!
    expect(hyper.findings).toHaveLength(1)
    expect(hyper.ecosystem).toBe('cargo')
    expect(hyper.bestTier).toBe('internal')
    expect(hyper.exposedCritical).toBe(false)
  })

  it('leaves out snoozed, accepted, dismissed, fixed, blind spot and image only findings', () => {
    const ids = new Set(fixes().flatMap((f) => f.findings.map((x) => x.finding.id)))
    const { findings } = world
    for (const excluded of [
      findings.xmlSnoozed,
      findings.xmlAccepted,
      findings.xmlDismissed,
      findings.xmlFixed,
      findings.hyperStaleLedger,
      world.blind,
      world.coverage,
    ]) {
      expect(ids.has(excluded.id)).toBe(false)
    }
    expect(fixes().some((f) => f.packageName === 'xml-lite')).toBe(false)
  })

  it('brings a snoozed finding back once it is reopened', () => {
    repos.findings.changeState(world.findings.xmlSnoozed.id, { state: 'open', actor: 'user' })
    expect(find(fixes(), 'xml-lite', '3.2.0')?.findings).toHaveLength(1)
  })

  it('narrows to a repo before grouping, so the target follows that repo', () => {
    const list = fixes({ repo: [world.ledger.id] })
    expect(list.map((f) => `${f.packageName}@${f.target}`)).toEqual([
      'kestrel-http@2.0.1',
      'hyper-lite@0.14.9',
    ])
    expect(list[0]?.mixedTargets).toBe(false)
    expect(list[0]?.exposedCritical).toBe(false)
  })

  it('narrows to an app', () => {
    const list = fixes({ deployment: [world.web.id] })
    expect(list.map((f) => f.packageName)).toEqual(['kestrel-http', 'pad-ng', 'tiny-glob'])
    expect(find(list, 'kestrel-http', '2.1.0')?.findings).toHaveLength(3)
  })

  it('sorts by exposure impact: exposed criticals, then exposed count, then count', () => {
    const [first, second] = fixes()
    expect(first?.exposedCritical).toBe(true)
    expect(second?.exposedCritical).toBe(true)
    expect(first!.exposedCount).toBeGreaterThan(second!.exposedCount)
  })
})
