import {
  bulkFindingsResponseSchema,
  deploymentDeploysResponseSchema,
  deploymentsResponseSchema,
  findingDetailSchema,
  findingsResponseSchema,
  overviewResponseSchema,
  currentTime,
  nowMs,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { ScanSummary } from '../scan/index.js'
import { createTestApi, seedWorld } from './testing.js'

// Endpoints and fields added for the views. Every name and domain is fictional.

const future = (days = 7) => new Date(nowMs() + days * 86_400_000).toISOString()
const HOOK_URL = 'https://hooks.example.dev/hinomi/fictional-0001'

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('bulk decisions', () => {
  it('snoozes many findings and reports the ones that cannot move', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    repos.findings.changeState(world.lowDev.id, { state: 'fixed', actor: 'system' })
    const res = await call('POST', '/findings/bulk', {
      action: 'snooze',
      ids: [world.critical.id, world.lowDev.id, 9999, world.critical.id],
      reason: 'patch release planned',
      until: future(),
    })
    expect(res.status).toBe(200)
    const body = bulkFindingsResponseSchema.parse(res.json)
    expect(body.ok).toBe(1)
    expect(body.failed).toBe(2)
    expect(body.results).toEqual([
      { id: world.critical.id, ok: true, state: 'snoozed' },
      {
        id: world.lowDev.id,
        ok: false,
        error: { code: 'conflict', message: 'A fixed finding cannot be moved to snoozed' },
      },
      { id: 9999, ok: false, error: { code: 'not_found', message: 'Finding not found' } },
    ])
    expect(repos.findings.get(world.critical.id)?.stateReason).toBe('patch release planned')
  })

  it('accepts and reopens in bulk', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const accepted = bulkFindingsResponseSchema.parse(
      (
        await call('POST', '/findings/bulk', {
          action: 'accept',
          ids: [world.critical.id, world.undeployed.id],
          reason: 'internal network only',
          until: future(30),
        })
      ).json,
    )
    expect(accepted.ok).toBe(2)
    const reopened = bulkFindingsResponseSchema.parse(
      (
        await call('POST', '/findings/bulk', {
          action: 'reopen',
          ids: [world.critical.id, world.undeployed.id, world.lowDev.id],
        })
      ).json,
    )
    expect(reopened.results.map((r) => r.ok)).toEqual([true, true, false])
    expect(repos.findings.get(world.critical.id)?.state).toBe('open')
  })

  it('validates the body', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const both = await call('POST', '/findings/bulk', {
      action: 'snooze',
      ids: [world.critical.id],
      reason: 'x',
      until: future(),
      untilNewAdvisory: true,
    })
    expect(both.status).toBe(400)
    expect(errorOf(both.json).code).toBe('validation_failed')
    const none = await call('POST', '/findings/bulk', { action: 'snooze', ids: [], reason: 'x' })
    expect(none.status).toBe(400)
    const tooMany = await call('POST', '/findings/bulk', {
      action: 'reopen',
      ids: Array.from({ length: 201 }, (_, i) => i + 1),
    })
    expect(tooMany.status).toBe(400)
  })
})

describe('snooze until a new advisory', () => {
  it('stores the choice on the finding and rejects it for blind spots', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const res = await call('POST', `/findings/${world.critical.id}/snooze`, {
      reason: 'not reachable from our code',
      untilNewAdvisory: true,
    })
    expect(res.status).toBe(200)
    const detail = findingDetailSchema.parse(res.json)
    expect(detail).toMatchObject({
      state: 'snoozed',
      stateUntil: null,
      stateUntilNewAdvisory: true,
    })
    expect(detail.history[0]).toMatchObject({ type: 'snoozed', untilNewAdvisory: true })

    const blind = await call('POST', `/findings/${world.blind.id}/accept`, {
      reason: 'later',
      untilNewAdvisory: true,
    })
    expect(blind.status).toBe(400)
    expect(errorOf(blind.json).message).toBe('Only advisories can wait for a new advisory')

    const missing = await call('POST', `/findings/${world.critical.id}/accept`, { reason: 'x' })
    expect(missing.status).toBe(400)
  })
})

describe('source filter', () => {
  it('matches findings reported by every listed source with sourceMatch=all', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const any = findingsResponseSchema.parse(
      (await call('GET', '/findings?source=github,osv&kind=advisory')).json,
    )
    expect(any.items.map((i) => i.id).sort()).toEqual(
      [world.critical.id, world.lowDev.id, world.undeployed.id].sort(),
    )
    const both = findingsResponseSchema.parse(
      (await call('GET', '/findings?source=github,osv&sourceMatch=all')).json,
    )
    expect(both.items.map((i) => i.id)).toEqual([world.critical.id])
    expect((await call('GET', '/findings?sourceMatch=some')).status).toBe(400)
  })
})

describe('finding detail', () => {
  it('returns the advisory description and the dependency path from the lockfile', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    repos.advisories.upsert({
      advisoryKey: 'GHSA-aaaa-bbbb-cccc',
      ecosystem: 'npm',
      packageName: 'left-pad-ng',
      description: 'A crafted key lets an attacker set properties on Object.prototype.',
    })
    repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: world.advisory.id,
        repoId: world.repo.id,
        reportedBy: ['osv'],
        dependencyPath: ['kestrel-http', 'left-pad-ng'],
      },
      currentTime(),
    )
    const detail = findingDetailSchema.parse(
      (await call('GET', `/findings/${world.critical.id}`)).json,
    )
    expect(detail.advisory?.description).toBe(
      'A crafted key lets an attacker set properties on Object.prototype.',
    )
    expect(detail.dependency).toMatchObject({
      path: ['kestrel-http', 'left-pad-ng'],
      pathSource: 'lockfile',
    })
    const blind = findingDetailSchema.parse((await call('GET', `/findings/${world.blind.id}`)).json)
    expect(blind.dependency).toMatchObject({ path: null, pathSource: 'package' })
  })

  it('lists the notifications sent for it', async () => {
    const { call, repos, notifier } = createTestApi()
    const world = seedWorld(repos)
    await call('POST', '/notifications/channels', {
      kind: 'webhook',
      name: 'ops hook',
      url: HOOK_URL,
    })
    const before = findingDetailSchema.parse(
      (await call('GET', `/findings/${world.critical.id}`)).json,
    )
    expect(before.notifications).toEqual([])
    await notifier.handleScanFinished({
      changes: [{ findingId: world.critical.id, change: 'opened' }],
    } as unknown as ScanSummary)
    const detail = findingDetailSchema.parse(
      (await call('GET', `/findings/${world.critical.id}`)).json,
    )
    expect(detail.notifications).toHaveLength(1)
    expect(detail.notifications[0]).toMatchObject({
      channelName: 'ops hook',
      channelKind: 'webhook',
      event: 'opened',
    })
    expect(JSON.stringify(detail)).not.toContain(HOOK_URL)
  })
})

describe('overview and deployments', () => {
  it('counts repos and apps per funnel step and severities per tier', async () => {
    const { call, repos } = createTestApi()
    seedWorld(repos)
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.funnelReach).toEqual({
      total: { repos: 2, apps: 1 },
      deployed: { repos: 1, apps: 1 },
      runtime: { repos: 1, apps: 1 },
      criticalOrHigh: { repos: 1, apps: 1 },
      public: { repos: 1, apps: 1 },
      exposed: { repos: 1, apps: 1 },
    })
    expect(overview.tierSeverity.exposed).toEqual({ critical: 1, high: 0, moderate: 0, low: 0 })
    expect(overview.tierSeverity.dev).toEqual({ critical: 0, high: 0, moderate: 0, low: 1 })
    expect(overview.tierSeverity.not_deployed.critical).toBe(1)
  })

  it('reports exposed and blind spot counts per deployment', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const { items } = deploymentsResponseSchema.parse((await call('GET', '/deployments')).json)
    const web = items.find((d) => d.id === world.web.id)
    const proxy = items.find((d) => d.id === world.proxy.id)
    expect(web).toMatchObject({ exposed: 1, openBlindSpots: 0 })
    expect(proxy).toMatchObject({ exposed: 0, openBlindSpots: 1 })
  })
})

describe('deploy history', () => {
  function coolifyFetch(body: unknown, status = 200) {
    const calls: { url: string; auth: string | null }[] = []
    const fetch = ((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(Response.json(body, { status }))
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }

  const QUEUE = [
    {
      deployment_uuid: 'dpl-0002',
      status: 'finished',
      commit: 'b1c2d3e4f5a6b7c8d9e0',
      commit_message: 'fix: escape the search box',
      created_at: '2026-11-05T09:00:00.000000Z',
      updated_at: '2026-11-05T09:03:00.000000Z',
      is_webhook: true,
      rollback: false,
      logs: '[{"output":"secret-looking build log"}]',
    },
    {
      deployment_uuid: 'dpl-0001',
      status: 'failed',
      commit: 'HEAD',
      created_at: '2026-11-04 08:00:00',
      updated_at: '2026-11-04 08:01:00',
    },
  ]

  it('reads recent deploys and commits of an application from Coolify', async () => {
    const coolify = coolifyFetch({ count: 2, deployments: QUEUE })
    const { call, repos } = createTestApi({ sourceFetch: coolify.fetch })
    const world = seedWorld(repos)
    const res = await call('GET', `/deployments/${world.web.id}/deploys?limit=5`)
    expect(res.status).toBe(200)
    const body = deploymentDeploysResponseSchema.parse(res.json)
    expect(body.available).toBe(true)
    expect(body.items).toEqual([
      {
        id: 'dpl-0002',
        status: 'finished',
        commit: 'b1c2d3e4f5a6b7c8d9e0',
        commitMessage: 'fix: escape the search box',
        startedAt: '2026-11-05T09:00:00.000Z',
        finishedAt: '2026-11-05T09:03:00.000Z',
        webhook: true,
        rollback: false,
      },
      {
        id: 'dpl-0001',
        status: 'failed',
        commit: null,
        commitMessage: null,
        startedAt: '2026-11-04T08:00:00.000Z',
        finishedAt: '2026-11-04T08:01:00.000Z',
        webhook: false,
        rollback: false,
      },
    ])
    expect(coolify.calls[0]?.url).toBe(
      'https://coolify.example.dev/api/v1/deployments/applications/app-1?skip=0&take=5',
    )
    expect(coolify.calls[0]?.auth).toBe('Bearer coolify-token-fictional-0001')
    expect(res.text).not.toContain('build log')
  })

  it('accepts a bare array too', async () => {
    const coolify = coolifyFetch(QUEUE)
    const { call, repos } = createTestApi({ sourceFetch: coolify.fetch })
    const world = seedWorld(repos)
    const body = deploymentDeploysResponseSchema.parse(
      (await call('GET', `/deployments/${world.web.id}/deploys`)).json,
    )
    expect(body.items.map((d) => d.id)).toEqual(['dpl-0002', 'dpl-0001'])
  })

  it('says why when the history is not available', async () => {
    const coolify = coolifyFetch({ message: 'Unauthenticated.' }, 401)
    const { call, repos } = createTestApi({ sourceFetch: coolify.fetch })
    const world = seedWorld(repos)
    const service = deploymentDeploysResponseSchema.parse(
      (await call('GET', `/deployments/${world.proxy.id}/deploys`)).json,
    )
    expect(service).toMatchObject({ available: false, items: [] })
    expect(coolify.calls).toHaveLength(0)

    const rejected = deploymentDeploysResponseSchema.parse(
      (await call('GET', `/deployments/${world.web.id}/deploys`)).json,
    )
    expect(rejected.available).toBe(false)
    expect(rejected.reason).toContain('the token was rejected')
    expect(JSON.stringify(rejected)).not.toContain('coolify-token-fictional')

    expect((await call('GET', '/deployments/9999/deploys')).status).toBe(404)
    expect((await call('GET', `/deployments/${world.web.id}/deploys?limit=500`)).status).toBe(400)
  })
})
