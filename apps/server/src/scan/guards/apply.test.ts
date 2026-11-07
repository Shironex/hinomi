import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/client.js'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import { createTestRepositories } from '../../db/test-db.js'
import { guardFindingKey, type Repositories } from '../../repository/index.js'
import { applyOverridesNow, indexOverrides } from '../overrides.js'
import { tierOf } from '../rank.js'
import { runScan } from '../run.js'
import type { ScanSources } from '../sources.js'
import { snoozeFinding } from '../state.js'
import { findingCounts, listRankedFindings } from '../views.js'
import { fakeGuard, rootUserEvidence } from './testing.js'

// A fictional world: kestrel-co/harbor runs as harbor-web (public) and harbor-jobs (internal);
// kestrel-co/lantern runs as lantern-api, which is stopped.

const NO_SOURCES: ScanSources = {
  coolify: [],
  github: [],
  osv: null,
  fetchLockfiles: () => Promise.resolve([]),
  settings: { osvEnabled: false, includeAccountRepos: false, imageScan: 'off' },
}

let handle: DatabaseHandle
let repos: Repositories
let clock: Date
let harbor: RepoRow
let lantern: RepoRow
let web: DeploymentRow
let jobs: DeploymentRow
let stopped: DeploymentRow

function advance(ms = 60_000) {
  clock = new Date(clock.getTime() + ms)
}

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
  lantern = repos.repos.upsert({ owner: 'kestrel-co', name: 'lantern' })
  const deployment = (externalId: string, name: string, extra: Partial<DeploymentRow>) =>
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
        ...extra,
      },
      clock,
    )
  web = deployment('app-1', 'harbor-web', {
    reach: 'public',
    domains: ['https://harbor.example.dev'],
  })
  jobs = deployment('app-2', 'harbor-jobs', {})
  stopped = deployment('app-3', 'lantern-api', {
    status: 'exited:unhealthy',
    gitRepository: 'kestrel-co/lantern',
    repoId: lantern.id,
  })
})

afterEach(() => handle.close())

async function scan(guard = fakeGuard()) {
  advance()
  return runScan({ repositories: repos }, NO_SOURCES, { now: () => clock, guards: [guard.guard] })
}

function ranked(findingId: number) {
  const found = listRankedFindings(repos).find((r) => r.finding.id === findingId)
  if (!found) throw new Error(`no finding ${findingId}`)
  return found
}

function guardRow(subject: { deploymentId: number } | { repoId: number }, check = 'root_user') {
  return repos.findings.getByKey(guardFindingKey(check as 'root_user', subject))
}

function eventTypes(findingId: number) {
  return repos.findings
    .listEvents(findingId)
    .map((e) => e.type)
    .reverse()
}

describe('guard findings', () => {
  it('opens a finding per subject with its level and evidence, ranked in the reach tiers', async () => {
    const fake = fakeGuard()
    fake.state.results = [
      {
        subject: { deploymentId: web.id },
        level: 'fail',
        evidence: rootUserEvidence({ user: '' }),
      },
      { subject: { deploymentId: jobs.id }, level: 'fail', evidence: rootUserEvidence() },
      { subject: { deploymentId: stopped.id }, level: 'warn', evidence: rootUserEvidence() },
    ]
    const summary = await scan(fake)

    expect(summary.changes.filter((c) => c.change === 'opened')).toHaveLength(3)
    const onWeb = guardRow({ deploymentId: web.id })!
    expect(onWeb).toMatchObject({ kind: 'guard', guardCheck: 'root_user', guardLevel: 'fail' })
    expect(onWeb.evidence).toMatchObject({ check: 'root_user', user: '', line: 31 })

    const publicFail = ranked(onWeb.id)
    expect(publicFail.rank).toBe(28)
    expect(tierOf(publicFail)).toBe('exposed')
    const internalFail = ranked(guardRow({ deploymentId: jobs.id })!.id)
    expect(internalFail.rank).toBe(18)
    expect(tierOf(internalFail)).toBe('internal')
    // A stopped container is still configured as root: it keeps the finding, ranked low.
    const stoppedWarn = ranked(guardRow({ deploymentId: stopped.id })!.id)
    expect(stoppedWarn.rank).toBe(2)
    expect(tierOf(stoppedWarn)).toBe('not_deployed')
    expect(findingCounts(repos, clock).advisories.total).toBe(0)
    expect(findingCounts(repos, clock).guards).toMatchObject({ total: 3, needsAction: 2 })
  })

  it('shows unknown in the coverage tier, ranked below every advisory', async () => {
    const fake = fakeGuard()
    fake.state.results = [
      {
        subject: { deploymentId: web.id },
        level: 'unknown',
        evidence: rootUserEvidence({ source: 'none', reason: 'no container user here' }),
      },
    ]
    await scan(fake)
    const r = ranked(guardRow({ deploymentId: web.id })!.id)
    expect(tierOf(r)).toBe('coverage')
    expect(r.rank).toBeLessThan(1)
    expect(findingCounts(repos, clock).guards.needsAction).toBe(0)
  })

  it('ranks a repo subject by the reach of the deployments that run it', async () => {
    const fake = fakeGuard()
    fake.state.results = [
      { subject: { repoId: harbor.id }, level: 'fail', evidence: rootUserEvidence() },
    ]
    await scan(fake)
    const r = ranked(guardRow({ repoId: harbor.id })!.id)
    expect(r.reach).toBe('public')
    expect(r.deployments.map((d) => d.name).sort()).toEqual(['harbor-jobs', 'harbor-web'])
  })

  it('updates evidence in place when the level stays the same', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence({ line: 31 }) }]
    await scan(fake)
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence({ line: 40 }) }]
    const summary = await scan(fake)
    expect(summary.changes).toEqual([])
    const row = guardRow(subject)!
    expect(row.evidence).toMatchObject({ line: 40 })
    expect(eventTypes(row.id)).toEqual(['opened'])
  })

  it('escalates a worse level, reopening a snoozed row', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [{ subject, level: 'warn', evidence: rootUserEvidence() }]
    await scan(fake)
    const row = guardRow(subject)!
    snoozeFinding(repos.findings, row.id, {
      reason: 'base image change next sprint',
      until: new Date('2026-12-01T00:00:00Z'),
      now: clock,
    })

    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence({ user: '' }) }]
    const summary = await scan(fake)
    expect(summary.changes).toEqual([{ findingId: row.id, change: 'escalated' }])
    const after = guardRow(subject)!
    expect(after).toMatchObject({ state: 'open', guardLevel: 'fail' })
    expect(eventTypes(row.id)).toEqual(['opened', 'snoozed', 'reopened', 'escalated'])
    const escalated = repos.findings.listEvents(row.id)[0]!
    expect(escalated).toMatchObject({ type: 'escalated', reason: 'warn -> fail', actor: 'system' })
  })

  it('notes a better level without reopening or notifying', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    await scan(fake)
    fake.state.results = [{ subject, level: 'warn', evidence: rootUserEvidence() }]
    const summary = await scan(fake)
    const row = guardRow(subject)!
    expect(summary.changes).toEqual([{ findingId: row.id, change: 'level_changed' }])
    expect(row.guardLevel).toBe('warn')
    expect(repos.findings.listEvents(row.id)[0]).toMatchObject({
      type: 'level_changed',
      reason: 'fail -> warn',
    })
  })

  it('resolves a pass, keeps what the pass read, and reopens when it fails again', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    await scan(fake)
    fake.state.results = [
      { subject, level: 'pass', evidence: rootUserEvidence({ user: 'app', line: 44 }) },
    ]
    let summary = await scan(fake)
    const row = guardRow(subject)!
    expect(summary.changes).toEqual([{ findingId: row.id, change: 'fixed' }])
    expect(row).toMatchObject({ state: 'fixed', evidence: { user: 'app', line: 44 } })

    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    summary = await scan(fake)
    expect(summary.changes).toEqual([{ findingId: row.id, change: 'reopened' }])
    expect(eventTypes(row.id)).toEqual(['opened', 'resolved', 'reopened'])
  })

  it('leaves a row alone on null, on a subject left out, and when the check throws', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    await scan(fake)
    const row = guardRow(subject)!

    fake.state.results = [{ subject, level: null }]
    expect((await scan(fake)).changes).toEqual([])
    fake.state.results = []
    expect((await scan(fake)).changes).toEqual([])
    fake.state.error = new Error('GitHub rate limit')
    const summary = await scan(fake)
    expect(summary.status).toBe('succeeded')
    expect(summary.changes).toEqual([])
    expect(guardRow(subject)).toMatchObject({ id: row.id, state: 'open', guardLevel: 'fail' })
  })

  it('dedupes results for one subject, the worse level winning', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    fake.state.results = [
      { subject, level: 'pass' },
      { subject, level: 'fail', evidence: rootUserEvidence({ line: 9 }) },
      { subject, level: 'warn', evidence: rootUserEvidence({ line: 12 }) },
    ]
    const summary = await scan(fake)
    expect(summary.changes).toHaveLength(1)
    expect(guardRow(subject)).toMatchObject({ guardLevel: 'fail', evidence: { line: 9 } })
  })

  it('drops evidence of another check and subjects outside the context', async () => {
    const fake = fakeGuard()
    fake.state.results = [
      {
        subject: { deploymentId: web.id },
        level: 'fail',
        evidence: { check: 'docker_socket', mounts: [], checked: [] },
      },
      { subject: { deploymentId: 9999 }, level: 'fail', evidence: rootUserEvidence() },
      { subject: { repoId: 9999 }, level: 'fail', evidence: rootUserEvidence() },
    ]
    const summary = await scan(fake)
    expect(summary.status).toBe('succeeded')
    expect(summary.changes).toEqual([])
    expect(repos.findings.list({ kind: 'guard' })).toEqual([])
  })

  it('gives the check every deployment and the repos scanned this run', async () => {
    const fake = fakeGuard()
    await scan(fake)
    const ctx = fake.state.contexts[0]!
    expect(ctx.deployments.map((d) => d.name).sort()).toEqual([
      'harbor-jobs',
      'harbor-web',
      'lantern-api',
    ])
    expect(ctx.repos.map((r) => r.name).sort()).toEqual(['harbor', 'lantern'])
    expect(ctx.now).toEqual(clock)
  })
})

describe('check overrides', () => {
  const reason = 'runs as root on purpose, sandboxed host'

  it('stores a turned off check as accepted with the reason, and keeps it current', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    repos.checkOverrides.create({ check: 'root_user', subject, reason }, clock)
    fake.state.results = [{ subject, level: 'warn', evidence: rootUserEvidence() }]
    const summary = await scan(fake)
    const row = guardRow(subject)!
    expect(summary.changes.map((c) => c.change)).toEqual(['opened', 'turned_off'])
    expect(row).toMatchObject({ state: 'accepted', stateReason: reason, stateUntil: null })
    expect(repos.findings.listEvents(row.id)[0]).toMatchObject({
      type: 'turned_off',
      actor: 'user',
      reason,
    })

    // A worse level is recorded but the check stays off.
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    expect((await scan(fake)).changes.map((c) => c.change)).toEqual(['escalated'])
    expect(guardRow(subject)).toMatchObject({ state: 'accepted', guardLevel: 'fail' })
    expect(ranked(row.id).override).toMatchObject({ scope: 'deployment' })
  })

  it('turns a check off for every deployment of a repo', async () => {
    const fake = fakeGuard()
    repos.checkOverrides.create(
      { check: 'root_user', subject: { repoId: harbor.id }, reason },
      clock,
    )
    fake.state.results = [
      { subject: { deploymentId: web.id }, level: 'fail', evidence: rootUserEvidence() },
      { subject: { deploymentId: stopped.id }, level: 'fail', evidence: rootUserEvidence() },
    ]
    await scan(fake)
    expect(guardRow({ deploymentId: web.id })).toMatchObject({ state: 'accepted' })
    expect(guardRow({ deploymentId: stopped.id })).toMatchObject({ state: 'open' })
  })

  it('reopens a turned off finding when its override is removed', async () => {
    const fake = fakeGuard()
    const subject = { deploymentId: web.id }
    const override = repos.checkOverrides.create({ check: 'root_user', subject, reason }, clock)
    fake.state.results = [{ subject, level: 'fail', evidence: rootUserEvidence() }]
    await scan(fake)
    const row = guardRow(subject)!

    repos.checkOverrides.remove(override!.id)
    advance()
    expect(applyOverridesNow(repos, clock)).toEqual([{ findingId: row.id, change: 'reopened' }])
    expect(guardRow(subject)).toMatchObject({ state: 'open', stateReason: null })
    expect(repos.findings.listEvents(row.id)[0]?.data).toEqual({ reason: 'override_removed' })
  })

  it('turns off a repo blind spot when every deployment of the repo has it off', () => {
    const { finding } = repos.findings.observe(
      { kind: 'blind_spot', blindSpotType: 'archived_deployed', repoId: harbor.id },
      clock,
    )
    const check = 'archived_deployed'
    repos.checkOverrides.create({ check, subject: { deploymentId: web.id }, reason }, clock)
    expect(applyOverridesNow(repos, clock)).toEqual([])
    repos.checkOverrides.create({ check, subject: { deploymentId: jobs.id }, reason }, clock)
    expect(applyOverridesNow(repos, clock)).toEqual([
      { findingId: finding.id, change: 'turned_off' },
    ])
    expect(repos.findings.get(finding.id)).toMatchObject({ state: 'accepted', stateReason: reason })
  })

  it('ignores override rows naming a check it does not know', () => {
    const index = indexOverrides(
      [
        {
          id: 1,
          check: '__proto__' as 'root_user',
          deploymentId: web.id,
          repoId: null,
          reason,
          createdAt: clock,
          updatedAt: clock,
        },
      ],
      { deployments: [web], byRepo: new Map(), unmapped: [] },
    )
    expect(index.covering('root_user', { deploymentId: web.id })).toBeNull()
  })
})
