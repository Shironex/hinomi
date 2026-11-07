import {
  deploymentDetailSchema,
  deploymentsResponseSchema,
  findingDetailSchema,
  findingsResponseSchema,
  navCountsSchema,
  onboardingStateSchema,
  overviewResponseSchema,
  scanStatusSchema,
  sourcesResponseSchema,
  nowMs,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES } from './index.js'
import { createTestApi, seedWorld } from './testing.js'

const TOKEN = 'ghp_fictionalTokenValue0000000000000000'
const future = (days = 7) => new Date(nowMs() + days * 86_400_000).toISOString()

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('errors and validation', () => {
  it('answers unknown routes and malformed ids with the error shape', async () => {
    const { call } = createTestApi()
    const unknown = await call('GET', '/nope')
    expect(unknown.status).toBe(404)
    expect(errorOf(unknown.json).code).toBe('not_found')
    const badId = await call('GET', '/findings/abc')
    expect(badId.status).toBe(404)
    expect(errorOf(badId.json).code).toBe('not_found')
  })

  it('rejects unknown query keys and bad enum values', async () => {
    const { call } = createTestApi()
    const extra = await call('GET', '/findings?colour=red')
    expect(extra.status).toBe(400)
    expect(errorOf(extra.json).code).toBe('validation_failed')
    const badTier = await call('GET', '/findings?tier=exposed,lukewarm')
    expect(badTier.status).toBe(400)
    const badLimit = await call('GET', '/findings?limit=1000')
    expect(badLimit.status).toBe(400)
  })

  it('rejects invalid JSON, wrong content type and unknown body keys', async () => {
    const { call } = createTestApi()
    const broken = await call('PATCH', '/settings', '{"osvEnabled":')
    expect(broken.status).toBe(400)
    expect(errorOf(broken.json).code).toBe('invalid_json')
    const text = await call('PATCH', '/settings', 'osvEnabled=true', {
      'content-type': 'text/plain',
    })
    expect(text.status).toBe(415)
    const extra = await call('PATCH', '/settings', { osvEnabled: true, admin: true })
    expect(extra.status).toBe(400)
    expect(errorOf(extra.json).code).toBe('validation_failed')
  })

  it('refuses bodies over the size limit', async () => {
    const { call } = createTestApi()
    const res = await call('PATCH', '/settings', { pad: 'x'.repeat(MAX_BODY_BYTES + 10) })
    expect(res.status).toBe(413)
    expect(errorOf(res.json).code).toBe('payload_too_large')
  })
})

describe('sources', () => {
  it('stores a token but never returns it, in any response', async () => {
    const { call, repos } = createTestApi()
    const created = await call('POST', '/sources', {
      kind: 'github',
      name: 'kestrel',
      token: TOKEN,
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ kind: 'github', hasToken: true })
    expect(created.text).not.toContain(TOKEN)
    expect(created.text).not.toContain('"token":')

    const list = await call('GET', '/sources')
    expect(sourcesResponseSchema.parse(list.json).canStoreTokens).toBe(true)
    expect(list.text).not.toContain(TOKEN)

    const id = (created.json as { id: number }).id
    const patched = await call('PATCH', `/sources/${id}`, { token: `${TOKEN}-2`, enabled: false })
    expect(patched.status).toBe(200)
    expect(patched.text).not.toContain(TOKEN)
    expect(patched.json).toMatchObject({ enabled: false, hasToken: true })
    expect(repos.sources.getToken(id)).toBe(`${TOKEN}-2`)

    for (const path of ['/overview', `/sources/${id}`]) {
      expect((await call('GET', path)).text).not.toContain(TOKEN)
    }
  })

  it('needs HINOMI_SECRET_KEY to store a token and says so', async () => {
    const { call, logger } = createTestApi({ withSecret: false })
    const res = await call('POST', '/sources', {
      kind: 'coolify',
      name: 'main',
      baseUrl: 'https://coolify.example.dev',
      token: TOKEN,
    })
    expect(res.status).toBe(400)
    expect(errorOf(res.json).code).toBe('secret_key_missing')
    expect(errorOf(res.json).message).toContain('HINOMI_SECRET_KEY')
    expect(res.text).not.toContain(TOKEN)
    expect(logger.text()).not.toContain(TOKEN)
  })

  it('checks what each kind needs and keeps names unique', async () => {
    const { call } = createTestApi()
    const noUrl = await call('POST', '/sources', { kind: 'coolify', name: 'main', token: TOKEN })
    expect(noUrl.status).toBe(400)
    const noToken = await call('POST', '/sources', { kind: 'github', name: 'gh' })
    expect(noToken.status).toBe(400)
    const osvToken = await call('POST', '/sources', { kind: 'osv', name: 'osv', token: TOKEN })
    expect(osvToken.status).toBe(400)
    const badUrl = await call('POST', '/sources', {
      kind: 'coolify',
      name: 'main',
      baseUrl: 'ftp://coolify.example.dev',
      token: TOKEN,
    })
    expect(badUrl.status).toBe(400)
    expect(badUrl.text).not.toContain(TOKEN)
    expect((await call('POST', '/sources', { kind: 'osv', name: 'osv' })).status).toBe(201)
    const twice = await call('POST', '/sources', { kind: 'osv', name: 'osv' })
    expect(twice.status).toBe(409)
    expect(errorOf(twice.json).code).toBe('conflict')
  })

  it('tests saved and unsaved credentials through the testers', async () => {
    const { call, testers } = createTestApi()
    const unsaved = await call('POST', '/sources/test', { kind: 'github', token: TOKEN })
    expect(unsaved.json).toEqual({
      ok: true,
      message: 'Connected as kestrel-bot',
      login: 'kestrel-bot',
    })
    expect(testers.github).toHaveBeenCalledWith({ baseUrl: null, token: TOKEN })

    const created = await call('POST', '/sources', {
      kind: 'coolify',
      name: 'main',
      baseUrl: 'https://coolify.example.dev',
      token: TOKEN,
    })
    const id = (created.json as { id: number }).id
    testers.coolify.mockResolvedValueOnce({
      ok: false,
      code: 'unauthorized',
      message: 'the token was rejected',
    })
    const saved = await call('POST', `/sources/${id}/test`)
    expect(saved.json).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'the token was rejected',
    })
    expect(testers.coolify).toHaveBeenCalledWith({
      baseUrl: 'https://coolify.example.dev',
      token: TOKEN,
    })
    expect(saved.text).not.toContain(TOKEN)
  })

  it('deletes a source', async () => {
    const { call } = createTestApi()
    const created = await call('POST', '/sources', { kind: 'osv', name: 'osv' })
    const id = (created.json as { id: number }).id
    expect((await call('DELETE', `/sources/${id}`)).status).toBe(204)
    expect((await call('GET', `/sources/${id}`)).status).toBe(404)
  })
})

describe('findings', () => {
  it('lists ranked findings with factors, tiers and joins, hiding fixed by default', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    repos.findings.changeState(world.lowDev.id, { state: 'fixed', actor: 'system' })

    const res = await call('GET', '/findings')
    expect(res.status).toBe(200)
    const body = findingsResponseSchema.parse(res.json)
    expect(body.total).toBe(3)
    const first = body.items[0]!
    expect(first.id).toBe(world.critical.id)
    expect(first).toMatchObject({
      tier: 'exposed',
      factors: { severity: 'critical', runtime: true, deployed: true, public: true },
      unscored: false,
      sources: ['github', 'osv'],
      repo: { fullName: 'kestrel-co/storefront' },
      deployments: [{ name: 'storefront-web', reach: 'public' }],
      advisory: { packageName: 'left-pad-ng', summary: 'Prototype pollution in left-pad-ng' },
    })

    const withFixed = findingsResponseSchema.parse(
      (await call('GET', '/findings?state=open,fixed')).json,
    )
    expect(withFixed.total).toBe(4)
  })

  it('filters, searches, groups and pages', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const get = async (query: string) =>
      findingsResponseSchema.parse((await call('GET', `/findings?${query}`)).json)

    expect((await get('kind=blind_spot')).items.map((i) => i.id)).toEqual([world.blind.id])
    expect((await get('tier=not_deployed')).items.map((i) => i.id)).toEqual([world.undeployed.id])
    expect((await get('scope=dev')).items.map((i) => i.id)).toEqual([world.lowDev.id])
    expect((await get('source=osv')).total).toBe(2)
    expect((await get(`repo=${world.other.id}`)).total).toBe(1)
    expect((await get('q=CVE-2026-0001')).total).toBe(2)
    expect((await get('q=TINY')).items[0]?.advisory?.packageName).toBe('tiny-glob')
    expect((await get('severity=low')).total).toBe(1)

    const page = await get('limit=2')
    expect(page.items).toHaveLength(2)
    expect(page.nextOffset).toBe(2)
    const last = await get('limit=2&offset=2')
    expect(last.items).toHaveLength(2)
    expect(last.nextOffset).toBeNull()

    const grouped = await get('group=tier')
    expect(grouped.groups.map((g) => g.key)).toEqual([
      'blind_spot',
      'exposed',
      'dev',
      'not_deployed',
    ])
    expect(grouped.items[0]?.id).toBe(world.blind.id)
    const byRepo = await get('group=repo')
    expect(byRepo.groups[0]).toMatchObject({ label: 'kestrel-co/storefront', count: 2 })
  })

  it('returns the detail with versions, dependency info and history', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const res = await call('GET', `/findings/${world.critical.id}`)
    const detail = findingDetailSchema.parse(res.json)
    expect(detail.versions).toEqual({
      installed: '2.0.0',
      firstPatched: '2.0.1',
      vulnerableRanges: ['< 2.0.1'],
    })
    expect(detail.dependency).toEqual({
      path: null,
      pathSource: 'manifest',
      scope: 'runtime',
      manifestPaths: ['package-lock.json'],
    })
    expect(detail.history.map((e) => e.type)).toEqual(['opened'])
    expect((await call('GET', '/findings/9999')).status).toBe(404)
  })

  it('snoozes with a reason and a future expiry, then reopens', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const path = `/findings/${world.critical.id}`

    const noReason = await call('POST', `${path}/snooze`, { reason: '  ', until: future() })
    expect(noReason.status).toBe(400)
    expect(errorOf(noReason.json).message).toContain('reason')
    const noUntil = await call('POST', `${path}/snooze`, { reason: 'Upgrade planned' })
    expect(noUntil.status).toBe(400)
    const past = await call('POST', `${path}/snooze`, {
      reason: 'Upgrade planned',
      until: new Date(nowMs() - 60_000).toISOString(),
    })
    expect(past.status).toBe(400)
    expect(errorOf(past.json).message).toContain('future')

    const until = future(14)
    const snoozed = await call('POST', `${path}/snooze`, { reason: 'Upgrade planned', until })
    expect(snoozed.status).toBe(200)
    expect(findingDetailSchema.parse(snoozed.json)).toMatchObject({
      state: 'snoozed',
      stateReason: 'Upgrade planned',
      stateUntil: until,
    })
    const counts = navCountsSchema.parse((await call('GET', '/shell/nav-counts')).json)
    expect(counts.needsAction).toBe(0)

    const reopened = await call('POST', `${path}/reopen`, {})
    expect(findingDetailSchema.parse(reopened.json).state).toBe('open')
    const accepted = await call('POST', `${path}/accept`, { reason: 'Not reachable', until })
    const detail = findingDetailSchema.parse(accepted.json)
    expect(detail.state).toBe('accepted')
    expect(detail.history.map((e) => [e.type, e.actor])).toEqual([
      ['accepted', 'user'],
      ['reopened', 'user'],
      ['snoozed', 'user'],
      ['opened', 'system'],
    ])
  })

  it('answers 409 for a transition the state does not allow and 404 for a missing finding', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    repos.findings.changeState(world.critical.id, { state: 'fixed', actor: 'system' })
    const fixed = await call('POST', `/findings/${world.critical.id}/snooze`, {
      reason: 'Later',
      until: future(),
    })
    expect(fixed.status).toBe(409)
    expect(errorOf(fixed.json).code).toBe('conflict')
    const reopenOpen = await call('POST', `/findings/${world.lowDev.id}/reopen`, {})
    expect(reopenOpen.status).toBe(409)
    const missing = await call('POST', '/findings/9999/accept', { reason: 'x', until: future() })
    expect(missing.status).toBe(404)
  })
})

describe('deployments and repo overrides', () => {
  it('joins deployment, repo, mapping, coverage and open findings', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const list = deploymentsResponseSchema.parse((await call('GET', '/deployments')).json)
    const web = list.items.find((d) => d.id === world.web.id)!
    expect(web).toMatchObject({
      mapping: 'auto',
      repos: [{ fullName: 'kestrel-co/storefront' }],
      coverage: { alerts: 'enabled', blindSpots: [], covered: true },
      openFindings: { critical: 1, high: 0, moderate: 0, low: 1 },
      source: { kind: 'coolify', name: 'main' },
    })
    const proxy = list.items.find((d) => d.id === world.proxy.id)!
    expect(proxy).toMatchObject({
      mapping: 'none',
      coverage: { alerts: 'none', blindSpots: ['no_repo_mapping'], covered: false },
    })

    const detail = deploymentDetailSchema.parse(
      (await call('GET', `/deployments/${world.web.id}`)).json,
    )
    expect(detail.findings.map((f) => f.id)).toEqual([world.critical.id, world.lowDev.id])
    expect((await call('GET', '/deployments/9999')).status).toBe(404)
  })

  it('adds, lists and removes manual repo mappings', async () => {
    const { call, repos } = createTestApi()
    const world = seedWorld(repos)
    const path = `/deployments/${world.proxy.id}/overrides`
    const bad = await call('POST', path, { repo: 'not a repo' })
    expect(bad.status).toBe(400)
    const added = await call('POST', path, { repo: 'Kestrel-Co/Image-Proxy', note: 'monorepo' })
    expect(added.status).toBe(201)
    expect(added.json).toMatchObject({
      items: [{ repo: { fullName: 'kestrel-co/image-proxy' }, note: 'monorepo' }],
    })
    const detail = deploymentDetailSchema.parse(
      (await call('GET', `/deployments/${world.proxy.id}`)).json,
    )
    expect(detail.mapping).toBe('override')
    const repoId = detail.overrides[0]!.repo.id
    expect((await call('DELETE', `${path}/${repoId}`)).json).toEqual({ items: [] })
    expect((await call('DELETE', `${path}/${repoId}`)).status).toBe(404)
  })
})

describe('settings', () => {
  it('reads defaults and validates updates', async () => {
    const { call } = createTestApi()
    expect((await call('GET', '/settings')).json).toEqual({
      scanIntervalMinutes: 360,
      osvEnabled: true,
      includeAccountRepos: false,
      updateCheckEnabled: true,
      supportWindowDays: 90,
      imageScan: 'off',
      rustBehindReleases: 4,
      bunBehindReleases: 4,
    })
    expect((await call('PATCH', '/settings', { scanIntervalMinutes: 5 })).status).toBe(400)
    expect((await call('PATCH', '/settings', { imageScan: 'sidecar' })).status).toBe(400)
    expect((await call('PATCH', '/settings', {})).status).toBe(400)
    expect((await call('PATCH', '/settings', { supportWindowDays: 0 })).status).toBe(400)
    expect((await call('PATCH', '/settings', { rustBehindReleases: 0 })).status).toBe(400)
    expect((await call('PATCH', '/settings', { bunBehindReleases: 51 })).status).toBe(400)
    const updated = await call('PATCH', '/settings', {
      scanIntervalMinutes: 30,
      includeAccountRepos: true,
      supportWindowDays: 30,
      imageScan: 'coolify',
      rustBehindReleases: 6,
      bunBehindReleases: 2,
    })
    expect(updated.json).toEqual({
      scanIntervalMinutes: 30,
      osvEnabled: true,
      includeAccountRepos: true,
      updateCheckEnabled: true,
      supportWindowDays: 30,
      imageScan: 'coolify',
      rustBehindReleases: 6,
      bunBehindReleases: 2,
    })
  })
})

describe('scans, overview and shell', () => {
  it('runs one scan at a time and reports its progress', async () => {
    const { call, repos, scan, scheduler } = createTestApi()
    seedWorld(repos)

    const first = await call('POST', '/scans')
    expect(first.status).toBe(202)
    expect(first.json).toMatchObject({
      started: true,
      run: { status: 'running', trigger: 'manual' },
    })
    const second = await call('POST', '/scans')
    expect(second.status).toBe(200)
    expect(second.json).toMatchObject({
      started: false,
      run: { id: (first.json as { run: { id: number } }).run.id },
    })
    expect(scan.runScan).toHaveBeenCalledTimes(1)

    const status = scanStatusSchema.parse((await call('GET', '/shell/scan-status')).json)
    expect(status).toEqual({
      state: 'scanning',
      scanRunId: (first.json as { run: { id: number } }).run.id,
      startedAt: expect.any(String) as string,
      phase: 'alerts',
      done: 0,
      total: 2,
      skipped: ['lockfiles'],
    })

    scan.finish()
    await scheduler.idle()
    const runs = (await call('GET', '/scans')).json as { items: { status: string }[] }
    expect(runs.items.map((r) => r.status)).toEqual(['succeeded'])
    const idle = scanStatusSchema.parse((await call('GET', '/shell/scan-status')).json)
    expect(idle.state).toBe('idle')
    expect((await call('GET', '/scans/9999')).status).toBe(404)
  })

  it('reports unconfigured before a source is connected', async () => {
    const { call } = createTestApi()
    expect((await call('GET', '/shell/scan-status')).json).toEqual({ state: 'unconfigured' })
  })

  it('reports queued between connecting a source and the first scan', async () => {
    const { call, repos } = createTestApi()
    seedWorld(repos)
    expect((await call('GET', '/shell/scan-status')).json).toEqual({
      state: 'queued',
      nextScanAt: null,
    })
  })

  it('refuses to start a scan while the server shuts down', async () => {
    const { call, repos, scheduler } = createTestApi()
    seedWorld(repos)
    await scheduler.shutdown(100)
    const res = await call('POST', '/scans')
    expect(res.status).toBe(503)
    expect(errorOf(res.json).code).toBe('unavailable')
  })

  it('reports a failed last scan with its message', async () => {
    const { call, repos } = createTestApi()
    seedWorld(repos)
    const run = repos.scanRuns.start('schedule')
    repos.scanRuns.finish(run.id, {
      status: 'failed',
      sourceResults: { coolify: { status: 'error', counts: {}, error: 'Coolify answered 401' } },
    })
    expect((await call('GET', '/shell/scan-status')).json).toEqual({
      state: 'failed',
      lastScanAt: null,
      message: 'Coolify answered 401',
    })
  })

  it('serves the overview funnel, tiers, sources and recent activity', async () => {
    const { call, repos } = createTestApi()
    seedWorld(repos)
    const overview = overviewResponseSchema.parse((await call('GET', '/overview')).json)
    expect(overview.funnel).toMatchObject({ total: 3, deployed: 2, exposed: 1, needsAction: 1 })
    expect(overview.blindSpots.total).toBe(1)
    expect(overview.tiers).toMatchObject({ exposed: 1, dev: 1, not_deployed: 1, blind_spot: 1 })
    expect(overview.sources).toEqual([
      expect.objectContaining({ kind: 'coolify', name: 'main', status: 'never' }),
      expect.objectContaining({ id: null, kind: 'osv', status: 'never' }),
    ])
    expect(overview.recentActivity).toHaveLength(4)
    expect(overview.recentActivity[0]?.finding.title).toBeTruthy()

    const counts = navCountsSchema.parse((await call('GET', '/shell/nav-counts')).json)
    expect(counts).toEqual({
      needsAction: 1,
      deployments: 2,
      alerts: 4,
      activeFixRuns: 0,
      guards: 0,
    })
  })
})

describe('OSV.dev on the overview', () => {
  const osvRow = async (call: ReturnType<typeof createTestApi>['call']) =>
    overviewResponseSchema
      .parse((await call('GET', '/overview')).json)
      .sources.filter((s) => s.kind === 'osv')

  it('lists OSV.dev without a source row, from the last scans and the setting', async () => {
    const { call, repos } = createTestApi()
    const ok = repos.scanRuns.start('manual', new Date('2026-11-05T10:00:00Z'))
    repos.scanRuns.finish(
      ok.id,
      { status: 'succeeded', sourceResults: { osv: { status: 'ok', counts: {} } } },
      new Date('2026-11-05T10:05:00Z'),
    )
    expect(await osvRow(call)).toEqual([
      expect.objectContaining({ id: null, status: 'ok', lastOkAt: '2026-11-05T10:05:00.000Z' }),
    ])

    const bad = repos.scanRuns.start('manual', new Date('2026-11-06T10:00:00Z'))
    repos.scanRuns.finish(
      bad.id,
      {
        status: 'partial',
        sourceResults: { osv: { status: 'error', counts: {}, error: '1 of 3 failed' } },
      },
      new Date('2026-11-06T10:05:00Z'),
    )
    expect(await osvRow(call)).toEqual([
      expect.objectContaining({ status: 'error', lastError: '1 of 3 failed' }),
    ])

    await call('PATCH', '/settings', { osvEnabled: false })
    expect(await osvRow(call)).toEqual([expect.objectContaining({ status: 'disabled' })])
  })

  it('uses the OSV source row when there is one', async () => {
    const { call } = createTestApi()
    await call('POST', '/sources', { kind: 'osv', name: 'osv' })
    const rows = await osvRow(call)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toEqual(expect.any(Number))
  })
})

describe('onboarding', () => {
  it('starts unfinished and keeps both flags on the server', async () => {
    const { call } = createTestApi()
    expect(onboardingStateSchema.parse((await call('GET', '/onboarding')).json)).toEqual({
      finished: false,
      alertsSkipped: false,
    })
    const skipped = await call('PATCH', '/onboarding', { alertsSkipped: true })
    expect(skipped.json).toEqual({ finished: false, alertsSkipped: true })
    await call('PATCH', '/onboarding', { finished: true })
    expect((await call('GET', '/onboarding')).json).toEqual({ finished: true, alertsSkipped: true })
  })

  it('counts an install with a completed scan as finished until told otherwise', async () => {
    const { call, repos } = createTestApi()
    const failed = repos.scanRuns.start('boot')
    repos.scanRuns.finish(failed.id, { status: 'failed', sourceResults: {} })
    expect((await call('GET', '/onboarding')).json).toMatchObject({ finished: false })
    const ok = repos.scanRuns.start('schedule')
    repos.scanRuns.finish(ok.id, { status: 'partial', sourceResults: {} })
    expect((await call('GET', '/onboarding')).json).toMatchObject({ finished: true })
    await call('PATCH', '/onboarding', { finished: false })
    expect((await call('GET', '/onboarding')).json).toMatchObject({ finished: false })
  })

  it('rejects empty and unknown updates', async () => {
    const { call } = createTestApi()
    expect((await call('PATCH', '/onboarding', {})).status).toBe(400)
    const unknown = await call('PATCH', '/onboarding', { finished: true, step: 3 })
    expect(unknown.status).toBe(400)
    expect(errorOf(unknown.json).code).toBe('validation_failed')
  })
})
