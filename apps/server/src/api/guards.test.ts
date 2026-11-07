import {
  checkOverrideSchema,
  checkOverridesResponseSchema,
  deploymentDetailSchema,
  findingsResponseSchema,
  guardsResponseSchema,
  navCountsSchema,
  nowMs,
  overviewResponseSchema,
  currentTime,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { Repositories } from '../repository/index.js'
import { fakeGuard, rootUserEvidence } from '../scan/guards/testing.js'
import { createTestApi, seedWorld } from './testing.js'

// Guards, check overrides and the guard parts of other endpoints. Every name is fictional.

const future = (days = 7) => new Date(nowMs() + days * 86_400_000).toISOString()

function errorOf(json: unknown) {
  return (json as { error: { code: string } }).error
}

function setup() {
  const fake = fakeGuard('root_user')
  const api = createTestApi({ guards: [fake.guard] })
  const world = seedWorld(api.repos)
  const rootFail = observeGuard(api.repos, { deploymentId: world.web.id }, 'fail')
  return { ...api, world, rootFail }
}

function observeGuard(
  repos: Repositories,
  subject: { deploymentId: number } | { repoId: number },
  level: 'warn' | 'fail' | 'unknown',
) {
  return repos.findings.observe(
    {
      kind: 'guard',
      guardCheck: 'root_user',
      subject,
      guardLevel: level,
      evidence: rootUserEvidence(),
    },
    currentTime(),
  ).finding
}

describe('GET /api/guards', () => {
  it('lists every check with copy, capabilities of connected sources, counts and overrides', async () => {
    const { call, repos, world } = setup()
    repos.checkOverrides.create({
      check: 'root_user',
      subject: { deploymentId: world.proxy.id },
      reason: 'vendor image, cannot change',
    })
    const body = guardsResponseSchema.parse((await call('GET', '/guards')).json)
    expect(body.items.map((i) => i.check)).toHaveLength(8)
    const root = body.items.find((i) => i.check === 'root_user')!
    expect(root).toMatchObject({
      title: 'Container runs as root',
      levels: ['fail', 'warn', 'unknown'],
      capabilities: { coolify: 'partial' },
      counts: { fail: 1, warn: 0, unknown: 0 },
      overrides: 1,
    })
    // Not registered yet: no source can answer it.
    expect(body.items.find((i) => i.check === 'docker_socket')?.capabilities).toEqual({})
  })
})

describe('/api/overrides', () => {
  it('turns a check off, edits the reason and turns it back on', async () => {
    const { call, repos, world, rootFail } = setup()
    const created = await call('POST', '/overrides', {
      check: 'root_user',
      deploymentId: world.web.id,
      reason: 'sandboxed host, root needed for the legacy agent',
    })
    expect(created.status).toBe(201)
    const override = checkOverrideSchema.parse(created.json)
    expect(override).toMatchObject({
      check: 'root_user',
      deployment: { id: world.web.id, name: 'storefront-web' },
      repo: null,
    })
    expect(repos.findings.get(rootFail.id)).toMatchObject({
      state: 'accepted',
      stateReason: 'sandboxed host, root needed for the legacy agent',
    })

    const patched = await call('PATCH', `/overrides/${override.id}`, { reason: 'still sandboxed' })
    expect(checkOverrideSchema.parse(patched.json).reason).toBe('still sandboxed')
    expect(repos.findings.get(rootFail.id)?.stateReason).toBe('still sandboxed')

    const listed = checkOverridesResponseSchema.parse(
      (await call('GET', `/overrides?check=root_user&deployment=${world.web.id}`)).json,
    )
    expect(listed.items.map((o) => o.id)).toEqual([override.id])
    const none = checkOverridesResponseSchema.parse(
      (await call('GET', '/overrides?check=docker_socket')).json,
    )
    expect(none.items).toEqual([])

    expect((await call('DELETE', `/overrides/${override.id}`)).status).toBe(204)
    expect(repos.findings.get(rootFail.id)).toMatchObject({ state: 'open', stateReason: null })
    expect((await call('DELETE', `/overrides/${override.id}`)).status).toBe(404)
  })

  it('turns a blind spot off and refuses duplicates, unknown subjects and bad bodies', async () => {
    const { call, world, repos } = setup()
    const body = { check: 'no_repo_mapping', deploymentId: world.proxy.id, reason: 'template' }
    expect((await call('POST', '/overrides', body)).status).toBe(201)
    expect(repos.findings.get(world.blind.id)?.state).toBe('accepted')
    const dup = await call('POST', '/overrides', body)
    expect(dup.status).toBe(409)
    expect(errorOf(dup.json).code).toBe('conflict')

    const missing = await call('POST', '/overrides', { ...body, deploymentId: 9999 })
    expect(missing.status).toBe(404)
    const missingRepo = await call('POST', '/overrides', {
      check: 'root_user',
      repoId: 9999,
      reason: 'x',
    })
    expect(missingRepo.status).toBe(404)
    for (const bad of [
      { check: 'root_user', reason: 'no subject' },
      { check: 'root_user', deploymentId: world.web.id, repoId: world.repo.id, reason: 'both' },
      { check: 'root_user', deploymentId: world.web.id, reason: '   ' },
      { check: 'root_user', deploymentId: world.web.id, reason: 'x'.repeat(501) },
      { check: '__proto__', deploymentId: world.web.id, reason: 'pollution' },
      { check: 'constructor', deploymentId: world.web.id, reason: 'pollution' },
    ]) {
      expect((await call('POST', '/overrides', bad)).status).toBe(400)
    }
    expect((await call('PATCH', '/overrides/9999', { reason: 'x' })).status).toBe(404)
  })
})

describe('guards on findings, deployments, the overview and the nav', () => {
  it('filters findings by check, level and release, with the guard part filled', async () => {
    const { call, repos, world, rootFail } = setup()
    const warn = observeGuard(repos, { deploymentId: world.proxy.id }, 'warn')
    const list = async (query: string) =>
      findingsResponseSchema.parse((await call('GET', `/findings?${query}`)).json).items

    const guards = await list('kind=guard')
    expect(guards.map((f) => f.id).sort()).toEqual([rootFail.id, warn.id].sort())
    expect((await list('check=root_user&level=fail')).map((f) => f.id)).toEqual([rootFail.id])
    expect(await list('check=docker_socket')).toEqual([])
    expect(await list('release=true')).toEqual([])
    expect((await list('release=false')).length).toBeGreaterThan(2)

    const item = guards.find((f) => f.id === rootFail.id)!
    expect(item).toMatchObject({
      tier: 'exposed',
      releaseTag: null,
      guard: {
        check: 'root_user',
        level: 'fail',
        title: 'Container runs as root',
        evidence: { check: 'root_user', line: 31 },
        override: null,
      },
    })
    expect(item.guard?.fixText).toContain('USER')
    const advisory = (await list('kind=advisory'))[0]!
    expect(advisory.guard).toBeNull()
  })

  it('refuses snoozing a guard until a new advisory', async () => {
    const { call, rootFail } = setup()
    const res = await call('POST', `/findings/${rootFail.id}/snooze`, {
      reason: 'later',
      untilNewAdvisory: true,
    })
    expect(res.status).toBe(400)
    const ok = await call('POST', `/findings/${rootFail.id}/snooze`, {
      reason: 'later',
      until: future(),
    })
    expect(ok.status).toBe(200)
  })

  it('lists the guards panel of a deployment', async () => {
    const { call, repos, world, rootFail } = setup()
    repos.checkOverrides.create({
      check: 'archived_deployed',
      subject: { deploymentId: world.web.id },
      reason: 'frozen on purpose',
    })
    const detail = deploymentDetailSchema.parse(
      (await call('GET', `/deployments/${world.web.id}`)).json,
    )
    const byCheck = new Map(detail.guards.map((g) => [g.check, g]))
    expect(byCheck.get('root_user')).toMatchObject({
      result: 'fail',
      findingId: rootFail.id,
      evidence: { check: 'root_user' },
    })
    // Not registered: no scan runs it yet.
    expect(byCheck.get('docker_socket')).toMatchObject({ result: null, findingId: null })
    expect(byCheck.get('archived_deployed')).toMatchObject({
      result: 'pass',
      override: { scope: 'deployment', reason: 'frozen on purpose' },
    })
    expect(byCheck.has('alerts_disabled')).toBe(false)

    const proxy = deploymentDetailSchema.parse(
      (await call('GET', `/deployments/${world.proxy.id}`)).json,
    )
    const proxyChecks = new Map(proxy.guards.map((g) => [g.check, g]))
    // Registered and nothing open: a pass. Its open blind spot is listed.
    expect(proxyChecks.get('root_user')).toMatchObject({ result: 'pass', findingId: null })
    expect(proxyChecks.get('no_repo_mapping')).toMatchObject({
      result: 'fail',
      findingId: world.blind.id,
    })
    expect(proxyChecks.get('archived_deployed')).toMatchObject({ result: null })
  })

  it('counts guards on the overview and the nav', async () => {
    const { call, repos, world } = setup()
    observeGuard(repos, { deploymentId: world.proxy.id }, 'unknown')
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.guardCounts.root_user).toEqual({ fail: 1, warn: 0, unknown: 1 })
    expect(overview.funnel.total).toBe(3)
    const nav = navCountsSchema.parse((await call('GET', '/shell/nav-counts')).json)
    expect(nav).toMatchObject({ guards: 1, activeFixRuns: 0 })
  })
})
