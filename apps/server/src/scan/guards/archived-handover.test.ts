import type { GuardEvidenceInput } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/client.js'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import { createTestRepositories } from '../../db/test-db.js'
import { guardFindingKey, type Repositories } from '../../repository/index.js'
import { runScan } from '../run.js'
import type { ScanSources } from '../sources.js'
import { acceptFinding, snoozeFinding } from '../state.js'
import { fakeGuard } from './testing.js'
import type { GuardSubjectResult } from './types.js'

// kestrel-co/harbor runs as harbor-web and harbor-jobs; an earlier version left an open
// archived_deployed blind spot on the repo. Every name is fictional.

const NO_SOURCES: ScanSources = {
  deployments: [],
  github: [],
  osv: null,
  fetchLockfiles: () => Promise.resolve([]),
  settings: { osvEnabled: false, includeAccountRepos: false, imageScan: 'off' },
}

let handle: DatabaseHandle
let repos: Repositories
let clock: Date
let harbor: RepoRow
let web: DeploymentRow
let jobs: DeploymentRow

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  clock = new Date('2026-11-08T10:00:00Z')
  const coolify = repos.sources.create({
    kind: 'coolify',
    name: 'main',
    baseUrl: 'https://coolify.example.dev',
    token: 'coolify-token-fictional-0001',
  })
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  const deployment = (externalId: string, name: string) =>
    repos.deployments.upsert(
      {
        sourceId: coolify.id,
        externalId,
        kind: 'application',
        name,
        domains: [],
        reach: 'internal',
        server: 'edge-1',
        status: 'running:healthy',
        gitRepository: 'kestrel-co/harbor',
        repoId: harbor.id,
      },
      clock,
    )
  web = deployment('app-1', 'harbor-web')
  jobs = deployment('app-2', 'harbor-jobs')
})

afterEach(() => handle.close())

const archived = (...repoRows: RepoRow[]): GuardEvidenceInput => ({
  check: 'archived_deployed',
  repos: (repoRows.length > 0 ? repoRows : [harbor]).map((repo) => ({
    repoId: repo.id,
    repo: `${repo.owner}/${repo.name}`,
    renamedTo: null,
    archived: true,
    pushedAt: null,
    result: 'fail' as const,
  })),
})

function oldBlindSpot(repo: RepoRow = harbor) {
  return repos.findings.observe(
    { kind: 'blind_spot', blindSpotType: 'archived_deployed', repoId: repo.id },
    clock,
  ).finding
}

/** harbor-web runs kestrel-co/ledger beside harbor (harbor-jobs still runs only harbor). */
function webAlsoRunsLedger(): RepoRow {
  const ledger = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger' })
  repos.deployments.addRepoOverride(web.id, harbor.id, 'monorepo')
  repos.deployments.addRepoOverride(web.id, ledger.id, 'monorepo')
  return ledger
}

async function scan(results: GuardSubjectResult[]) {
  clock = new Date(clock.getTime() + 60_000)
  const fake = fakeGuard('archived_deployed')
  fake.state.results = results
  return runScan({ repositories: repos }, NO_SOURCES, { now: () => clock, guards: [fake.guard] })
}

const fail = (d: DeploymentRow, ...repoRows: RepoRow[]): GuardSubjectResult => ({
  subject: { deploymentId: d.id },
  level: 'fail',
  evidence: archived(...repoRows),
})
const guardRow = (d: DeploymentRow) =>
  repos.findings.getByKey(guardFindingKey('archived_deployed', { deploymentId: d.id }))

describe('handing archived_deployed blind spots over to the guard', () => {
  it('leaves the old row open while the guard could not answer for a deployment', async () => {
    const old = oldBlindSpot()
    await scan([{ subject: { deploymentId: web.id }, level: null }, fail(jobs)])
    expect(repos.findings.get(old.id)?.state).toBe('open')
    await scan([])
    expect(repos.findings.get(old.id)?.state).toBe('open')
  })

  it('resolves the old row once every deployment has an outcome, reporting no fix', async () => {
    const old = oldBlindSpot()
    const summary = await scan([fail(web), { subject: { deploymentId: jobs.id }, level: 'pass' }])
    expect(repos.findings.get(old.id)?.state).toBe('fixed')
    expect(repos.findings.listEvents(old.id)[0]).toMatchObject({
      type: 'resolved',
      data: { reason: 'moved_to_guard', check: 'archived_deployed' },
    })
    expect(summary.changes).not.toContainEqual({ findingId: old.id, change: 'fixed' })
    expect(guardRow(web)).toMatchObject({ state: 'open', guardLevel: 'fail' })
  })

  it('carries a snooze over to every guard row that opened, with its reason and end', async () => {
    const old = oldBlindSpot()
    const until = new Date('2026-12-01T00:00:00Z')
    snoozeFinding(repos.findings, old.id, { reason: 'migrating off it', until, now: clock })
    const summary = await scan([fail(web), fail(jobs)])
    for (const d of [web, jobs]) {
      const row = guardRow(d)!
      expect(row).toMatchObject({ state: 'snoozed', stateReason: 'migrating off it' })
      expect(row.stateUntil?.toISOString()).toBe(until.toISOString())
      expect(repos.findings.listEvents(row.id)[0]).toMatchObject({
        type: 'carried_over',
        data: { fromFindingIds: [old.id] },
      })
      expect(summary.changes).not.toContainEqual({ findingId: row.id, change: 'opened' })
    }
    expect(repos.findings.get(old.id)?.state).toBe('fixed')
  })

  it('carries a time limited acceptance over too', async () => {
    const old = oldBlindSpot()
    const until = new Date('2027-01-15T00:00:00Z')
    acceptFinding(repos.findings, old.id, { reason: 'sunset in January', until, now: clock })
    await scan([fail(web), fail(jobs)])
    expect(guardRow(web)).toMatchObject({ state: 'accepted', stateReason: 'sunset in January' })
    expect(guardRow(web)?.stateUntil?.toISOString()).toBe(until.toISOString())
  })

  it('carries nothing onto a deployment where another bad repo has no deferred row', async () => {
    const ledger = webAlsoRunsLedger()
    const old = oldBlindSpot()
    const ledgerRow = oldBlindSpot(ledger)
    snoozeFinding(repos.findings, old.id, {
      reason: 'migrating off it',
      until: new Date('2026-12-01T00:00:00Z'),
      now: clock,
    })
    const summary = await scan([fail(web, harbor, ledger), fail(jobs)])
    const row = guardRow(web)!
    expect(row.state).toBe('open')
    expect(summary.changes).toContainEqual({ findingId: row.id, change: 'opened' })
    // harbor-jobs runs only the snoozed repo, so its row takes the snooze.
    expect(guardRow(jobs)).toMatchObject({ state: 'snoozed', stateReason: 'migrating off it' })
    expect(repos.findings.get(ledgerRow.id)?.state).toBe('fixed')
  })

  it('takes the earliest end when every bad repo of the deployment was deferred', async () => {
    const ledger = webAlsoRunsLedger()
    const old = oldBlindSpot()
    const ledgerRow = oldBlindSpot(ledger)
    snoozeFinding(repos.findings, old.id, {
      reason: 'migrating off it',
      until: new Date('2026-12-20T00:00:00Z'),
      now: clock,
    })
    const early = new Date('2026-12-05T00:00:00Z')
    acceptFinding(repos.findings, ledgerRow.id, {
      reason: 'ledger sunsets',
      until: early,
      now: clock,
    })
    const summary = await scan([fail(web, harbor, ledger), fail(jobs)])
    const row = guardRow(web)!
    expect(row).toMatchObject({ state: 'accepted', stateReason: 'ledger sunsets' })
    expect(row.stateUntil?.toISOString()).toBe(early.toISOString())
    expect(repos.findings.listEvents(row.id)[0]?.data).toEqual({
      fromFindingIds: [old.id, ledgerRow.id],
    })
    expect(summary.changes).not.toContainEqual({ findingId: row.id, change: 'opened' })
  })

  it('carries over in the scan a guard row opens, before every deployment is decided', async () => {
    const old = oldBlindSpot()
    const until = new Date('2026-12-01T00:00:00Z')
    snoozeFinding(repos.findings, old.id, { reason: 'migrating off it', until, now: clock })
    const first = await scan([fail(web), { subject: { deploymentId: jobs.id }, level: null }])
    expect(guardRow(web)).toMatchObject({ state: 'snoozed', stateReason: 'migrating off it' })
    expect(first.changes).not.toContainEqual({ findingId: guardRow(web)!.id, change: 'opened' })
    expect(repos.findings.get(old.id)?.state).toBe('snoozed')

    const second = await scan([fail(web), fail(jobs)])
    expect(guardRow(jobs)).toMatchObject({ state: 'snoozed', stateReason: 'migrating off it' })
    expect(second.changes).not.toContainEqual({ findingId: guardRow(jobs)!.id, change: 'opened' })
    expect(repos.findings.get(old.id)?.state).toBe('fixed')
  })

  it('lifts a carried snooze when another repo of the deployment turns archived', async () => {
    const ledger = webAlsoRunsLedger()
    const old = oldBlindSpot()
    snoozeFinding(repos.findings, old.id, {
      reason: 'migrating off it',
      until: new Date('2026-12-01T00:00:00Z'),
      now: clock,
    })
    await scan([fail(web, harbor), fail(jobs)])
    expect(guardRow(web)?.state).toBe('snoozed')

    const summary = await scan([fail(web, harbor, ledger), fail(jobs)])
    const row = guardRow(web)!
    expect(row.state).toBe('open')
    expect(summary.changes).toContainEqual({ findingId: row.id, change: 'escalated' })
    expect(repos.findings.listEvents(row.id)[0]).toMatchObject({
      type: 'escalated',
      reason: 'newly archived: kestrel-co/ledger',
    })
    // The same repos again is no news.
    const again = await scan([fail(web, harbor, ledger), fail(jobs)])
    expect(again.changes).not.toContainEqual({ findingId: row.id, change: 'escalated' })
  })

  it('carries nothing from an open row', async () => {
    oldBlindSpot()
    const summary = await scan([fail(web), fail(jobs)])
    const row = guardRow(web)!
    expect(row.state).toBe('open')
    expect(summary.changes).toContainEqual({ findingId: row.id, change: 'opened' })
  })

  it('resolves the old row as not deployed when nothing runs the repo any more', async () => {
    const old = oldBlindSpot()
    repos.deployments.addRepoOverride(
      web.id,
      repos.repos.upsert({ owner: 'kestrel-co', name: 'tern' }).id,
      'moved',
    )
    repos.deployments.addRepoOverride(
      jobs.id,
      repos.repos.upsert({ owner: 'kestrel-co', name: 'tern' }).id,
      'moved',
    )
    const summary = await scan([])
    expect(repos.findings.listEvents(old.id)[0]).toMatchObject({
      type: 'resolved',
      data: { reason: 'not_deployed' },
    })
    expect(summary.changes).toContainEqual({ findingId: old.id, change: 'fixed' })
  })
})
