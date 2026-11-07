import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { runScan, type ScanProgress, type ScanSummary } from './run.js'
import { SCAN_SETTING_KEYS } from './settings.js'
import { buildScanSources } from './sources.js'
import { tierOf } from './rank.js'
import { findingChangesSince, findingCounts, listRankedFindings } from './views.js'

// A fictional world: one Coolify instance on edge-1 and three repos of kestrel-co.
//
// harbor-web  public, alerts on: GitHub and OSV both report GHSA-hw (deduped)
// lantern-api public, alerts off: only OSV finds the critical GHSA-la
// dock-worker internal, alerts on, no lockfile (blind spot until one appears)
// static-docs image only, no git source (coverage note, not a blind spot)
// legacy-cron git source Hinomi cannot match to a repo (blind spot)

const COOLIFY = 'https://coolify.example.dev'
const GITHUB = 'https://api.github.com'
const OSV = 'https://api.osv.dev'

interface World {
  /** Per repo: status of GET /repos/{o}/{r} (200 or an error status). */
  repoStatus: Record<string, number>
  alertsStatus: Record<string, 204 | 404 | 403>
  /** GHSA ids GitHub reports per repo. */
  githubAlerts: Record<string, string[]>
  /** Installed version of each package per repo lockfile; null means no lockfile. */
  lockfiles: Record<string, Record<string, string> | null>
  /** GHSA ids dismissed on GitHub per repo, with the reason and comment given. */
  githubDismissed: Record<string, { ghsa: string; reason: string; comment: string }[]>
  /** Coolify status per app name; running:healthy when absent. */
  appStatus: Record<string, string>
  /** GitHub sent an empty vulnerable range for its alerts (only the first patched version). */
  blankRange: boolean
}

const ADVISORIES: Record<string, { pkg: string; severity: string; fixed: string; cve: string }> = {
  'GHSA-hw00-0000-0001': {
    pkg: 'example-parser',
    severity: 'HIGH',
    fixed: '1.2.5',
    cve: 'CVE-2026-0001',
  },
  'GHSA-la00-0000-0002': {
    pkg: 'example-yaml',
    severity: 'CRITICAL',
    fixed: '3.0.1',
    cve: 'CVE-2026-0002',
  },
}

function initialWorld(): World {
  return {
    repoStatus: { 'harbor-web': 200, 'lantern-api': 200, 'dock-worker': 200 },
    alertsStatus: { 'harbor-web': 204, 'lantern-api': 404, 'dock-worker': 204 },
    githubAlerts: { 'harbor-web': ['GHSA-hw00-0000-0001'], 'lantern-api': [], 'dock-worker': [] },
    lockfiles: {
      'harbor-web': { 'example-parser': '1.2.0' },
      'lantern-api': { 'example-yaml': '3.0.0' },
      'dock-worker': null,
    },
    githubDismissed: {},
    appStatus: {},
    blankRange: false,
  }
}

const bodyText = (init: RequestInit | undefined) =>
  typeof init?.body === 'string' ? init.body : '{}'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function coolifyResponse(world: World, path: string): Response {
  if (path === '/applications') {
    const app = (uuid: string, name: string, repo: string, fqdn: string | null) => ({
      uuid,
      name,
      git_repository: `https://github.com/kestrel-co/${repo}.git`,
      git_branch: 'main',
      fqdn,
      status: world.appStatus[name] ?? 'running:healthy',
      destination: { server: { name: 'edge-1' } },
    })
    return json([
      app('app-1', 'harbor-web', 'harbor-web', 'https://harbor.example.dev'),
      app('app-2', 'lantern-api', 'lantern-api', 'https://api.example.dev'),
      app('app-3', 'dock-worker', 'dock-worker', null),
      {
        uuid: 'app-4',
        name: 'static-docs',
        docker_registry_image_name: 'ghcr.io/kestrel-co/docs',
        fqdn: 'https://docs.example.dev',
        status: 'running:healthy',
      },
      {
        uuid: 'app-5',
        name: 'legacy-cron',
        git_repository: 'git@git.example.dev:legacy',
        git_branch: 'main',
        fqdn: null,
        status: 'running:healthy',
      },
    ])
  }
  if (path === '/databases')
    return json([{ uuid: 'db-1', name: 'harbor-db', image: 'postgres:17' }])
  return json([])
}

function packageLock(name: string, deps: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name, dependencies: deps } }
  for (const [pkg, version] of Object.entries(deps)) packages[`node_modules/${pkg}`] = { version }
  return JSON.stringify({ name, lockfileVersion: 3, packages })
}

function alertNode(ghsa: string, index: number, blankRange = false) {
  const a = ADVISORIES[ghsa]!
  return {
    number: index + 1,
    createdAt: '2026-10-01T00:00:00Z',
    dismissedAt: null,
    vulnerableManifestPath: 'package-lock.json',
    dependencyScope: 'RUNTIME',
    securityVulnerability: {
      severity: a.severity,
      vulnerableVersionRange: blankRange ? '' : `< ${a.fixed}`,
      firstPatchedVersion: { identifier: a.fixed },
      package: { name: a.pkg, ecosystem: 'NPM' },
      advisory: {
        ghsaId: ghsa,
        summary: `Fictional issue in ${a.pkg}`,
        publishedAt: '2026-09-01T00:00:00Z',
        identifiers: [
          { type: 'GHSA', value: ghsa },
          { type: 'CVE', value: a.cve },
        ],
        cvss: { score: 8.1, vectorString: null },
      },
    },
  }
}

function githubResponse(world: World, url: URL, init: RequestInit | undefined): Response {
  const path = url.pathname
  if (path === '/graphql') {
    const body = JSON.parse(bodyText(init)) as { query: string; variables: { name: string } }
    const repo = body.variables.name
    const nodes = body.query.includes('states: DISMISSED')
      ? (world.githubDismissed[repo] ?? []).map((d, i) => ({
          ...alertNode(d.ghsa, i + 50),
          dismissedAt: '2026-10-20T08:00:00Z',
          dismissReason: d.reason,
          dismissComment: d.comment,
        }))
      : (world.githubAlerts[repo] ?? []).map((ghsa, i) => alertNode(ghsa, i, world.blankRange))
    return json({
      data: {
        repository: {
          vulnerabilityAlerts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      },
    })
  }
  const match = /^\/repos\/kestrel-co\/([^/]+)(\/.*)?$/.exec(path)
  if (!match) return json({ message: 'Not Found' }, 404)
  const repo = match[1]!
  const rest = match[2] ?? ''
  if (rest === '') {
    const status = world.repoStatus[repo] ?? 404
    if (status !== 200) return json({ message: 'Not Found' }, status)
    return json({
      name: repo,
      owner: { login: 'kestrel-co' },
      archived: false,
      default_branch: 'main',
      visibility: 'public',
      pushed_at: '2026-11-01T00:00:00Z',
    })
  }
  if (rest === '/vulnerability-alerts') {
    const status = world.alertsStatus[repo] ?? 404
    return status === 204 ? new Response(null, { status }) : json({ message: 'x' }, status)
  }
  if (rest.startsWith('/contents')) {
    const deps = world.lockfiles[repo]
    if (rest === '/contents/' || rest === '/contents') {
      const entries = [{ name: 'package.json', path: 'package.json', type: 'file' }]
      if (deps) entries.push({ name: 'package-lock.json', path: 'package-lock.json', type: 'file' })
      return json(entries)
    }
    if (rest === '/contents/package-lock.json' && deps) {
      return new Response(packageLock(repo, deps), { status: 200 })
    }
  }
  return json({ message: 'Not Found' }, 404)
}

function osvVuln(ghsa: string) {
  const a = ADVISORIES[ghsa]!
  return {
    id: ghsa,
    summary: `Fictional issue in ${a.pkg}`,
    aliases: [a.cve],
    published: '2026-09-01T00:00:00Z',
    database_specific: { severity: a.severity },
    affected: [
      {
        package: { name: a.pkg, ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: a.fixed }] }],
      },
    ],
  }
}

function osvResponse(url: URL, init: RequestInit | undefined): Response {
  if (url.pathname === '/v1/querybatch') {
    const body = JSON.parse(bodyText(init)) as { queries: { package: { name: string } }[] }
    return json({
      results: body.queries.map((q) => {
        const ids = Object.keys(ADVISORIES).filter((id) => ADVISORIES[id]!.pkg === q.package.name)
        return ids.length > 0 ? { vulns: ids.map((id) => ({ id })) } : {}
      }),
    })
  }
  const vuln = /^\/v1\/vulns\/(.+)$/.exec(url.pathname)
  if (vuln) return json(osvVuln(decodeURIComponent(vuln[1]!)))
  return json({}, 404)
}

function mockFetch(world: World): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href)
    if (href.startsWith(COOLIFY)) {
      return Promise.resolve(coolifyResponse(world, url.pathname.replace('/api/v1', '')))
    }
    if (href.startsWith(GITHUB)) return Promise.resolve(githubResponse(world, url, init))
    if (href.startsWith(OSV)) return Promise.resolve(osvResponse(url, init))
    return Promise.reject(new Error(`unexpected request ${href}`))
  }
}

let repos: Repositories
let handle: DatabaseHandle
let world: World

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  world = initialWorld()
  repos.sources.create({ kind: 'coolify', name: 'edge', baseUrl: COOLIFY, token: 'coolify-token' })
  repos.sources.create({ kind: 'github', name: 'kestrel-co', token: 'github-token' })
})
afterEach(() => handle.close())

const day = 24 * 60 * 60 * 1000
const t0 = new Date('2026-11-06T06:00:00Z').getTime()

function scan(n: number): Promise<ScanSummary> {
  const sources = buildScanSources(repos, { fetch: mockFetch(world), osvMaxRetries: 0 })
  return runScan({ repositories: repos }, sources, { now: () => new Date(t0 + n * day) })
}

const repoId = (name: string) => repos.repos.getByName('kestrel-co', name)!.id

function advisoryFinding(repo: string, ghsa: string) {
  const advisory = repos.advisories.findByAnyId(ghsa)[0]!
  return repos.findings.list({ repoId: repoId(repo), advisoryId: advisory.id })[0]
}

function blindSpots() {
  return repos.findings
    .list({ kind: 'blind_spot' })
    .map((f) => `${f.blindSpotType}:${f.state}`)
    .sort()
}

describe('runScan', () => {
  it('joins Coolify, GitHub and OSV into deduped findings and blind spots', async () => {
    const summary = await scan(0)
    expect(summary.status).toBe('succeeded')
    expect(summary.errors).toEqual([])
    expect(summary.sourceResults.coolify).toMatchObject({
      status: 'ok',
      counts: { deployments: 6 },
    })
    expect(summary.sourceResults.github).toMatchObject({ status: 'ok', counts: { repos: 3 } })
    expect(summary.sourceResults.osv).toMatchObject({ status: 'ok', counts: { matches: 2 } })

    // The same advisory from GitHub and OSV is stored once and reported by both.
    expect(repos.advisories.findByAnyId('CVE-2026-0001')).toHaveLength(1)
    const harbor = advisoryFinding('harbor-web', 'GHSA-hw00-0000-0001')!
    expect(harbor).toMatchObject({
      state: 'open',
      scope: 'runtime',
      reportedBy: ['github', 'osv'],
      installedVersion: '1.2.0',
      manifestPaths: ['package-lock.json'],
    })
    expect(repos.advisories.get(harbor.advisoryId!)).toMatchObject({
      severity: 'high',
      firstPatchedVersion: '1.2.5',
      cvssScore: 8.1,
    })

    // Alerts are off on lantern-api: only OSV finds the critical.
    expect(advisoryFinding('lantern-api', 'GHSA-la00-0000-0002')).toMatchObject({
      state: 'open',
      reportedBy: ['osv'],
    })
    expect(repos.repos.getByName('kestrel-co', 'lantern-api')?.alertsEnabled).toBe(false)

    expect(blindSpots()).toEqual([
      'alerts_disabled:open',
      'lockfile_missing:open',
      'no_repo_mapping:open',
    ])
    // The blind spot is legacy-cron (a git source); static-docs gets a coverage note instead.
    const docs = repos.deployments.list().find((d) => d.name === 'static-docs')!
    const cron = repos.deployments.list().find((d) => d.name === 'legacy-cron')!
    expect(cron.gitRepository).toBe('git@git.example.dev:legacy')
    expect(repos.findings.list({ kind: 'blind_spot', deploymentId: cron.id })).toHaveLength(1)
    expect(repos.findings.list({ deploymentId: docs.id })).toMatchObject([
      { kind: 'coverage_note', state: 'open', dedupeKey: `note:image_only:deployment:${docs.id}` },
    ])
    expect(summary.findingsOpened).toBe(6)

    const scanRun = repos.scanRuns.get(summary.scanRunId)
    expect(scanRun).toMatchObject({ status: 'succeeded', findingsOpened: 6 })
    expect(repos.sources.listByKind('coolify')[0]?.lastOkAt).not.toBeNull()

    // Ranked: the critical on a public app and the alerts-off blind spot lead.
    const ranked = listRankedFindings(repos)
    expect(
      ranked
        .slice(0, 2)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['advisory', 'blind_spot'])
    expect(ranked[0]!.factors).toEqual({
      severity: 'critical',
      runtime: true,
      deployed: true,
      public: true,
    })
    const counts = findingCounts(repos, new Date(t0))
    expect(counts.advisories).toMatchObject({ total: 2, exposed: 2, needsAction: 2 })
    expect(counts.blindSpots.total).toBe(3)

    // The ranking phase stores a fix plan for every scanned repo.
    const plans = repos.fixPlans.latestPerRepo()
    expect(plans).toHaveLength(3)
    expect(plans.every((p) => p.scanRunId === summary.scanRunId)).toBe(true)
    const harborPlan = repos.fixPlans.forRepo(harbor.repoId!)!.plan
    expect(harborPlan.steps.map((s) => [s.packageName, s.to, s.lockfile])).toEqual([
      ['example-parser', '1.2.5', 'package-lock.json'],
    ])
  })

  it('reports each phase in order with its progress', async () => {
    const seen: ScanProgress[] = []
    const sources = buildScanSources(repos, { fetch: mockFetch(world), osvMaxRetries: 0 })
    await runScan({ repositories: repos }, sources, {
      now: () => new Date(t0),
      onProgress: (p) => seen.push(p),
    })
    // Phases only move forward, each starts at 0 and ends at its total.
    const order = [...new Set(seen.map((p) => p.phase))]
    expect(order).toEqual(['deployments', 'alerts', 'lockfiles', 'matching', 'ranking'])
    const last = (phase: ScanProgress['phase']) => seen.filter((p) => p.phase === phase).at(-1)
    expect(last('deployments')).toMatchObject({ done: 1, total: 1 })
    expect(last('alerts')).toMatchObject({ done: 3, total: 3 })
    expect(last('lockfiles')).toMatchObject({ done: 3, total: 3 })
    expect(last('matching')).toMatchObject({ done: 3, total: 3 })
    expect(last('ranking')).toMatchObject({ done: 0, total: 0 })
    expect(seen.every((p) => p.skipped.length === 0)).toBe(true)
  })

  it('names the phases a scan leaves out', async () => {
    repos.settings.set(SCAN_SETTING_KEYS.osvEnabled, false)
    const seen: ScanProgress[] = []
    const sources = buildScanSources(repos, { fetch: mockFetch(world), osvMaxRetries: 0 })
    await runScan({ repositories: repos }, sources, { onProgress: (p) => seen.push(p) })
    expect(seen.some((p) => p.phase === 'lockfiles')).toBe(false)
    expect(seen[0]?.skipped).toEqual(['lockfiles'])
  })

  it('keeps scanning when a progress listener throws', async () => {
    const sources = buildScanSources(repos, { fetch: mockFetch(world), osvMaxRetries: 0 })
    const summary = await runScan({ repositories: repos }, sources, {
      onProgress: () => {
        throw new Error('listener broke')
      },
    })
    expect(summary.status).toBe('succeeded')
  })

  it('never marks fixed while a source that reported it errored, and fixes once all agree', async () => {
    await scan(0)
    const id = advisoryFinding('harbor-web', 'GHSA-hw00-0000-0001')!.id

    // Day 1: the lockfile is bumped, but GitHub fails for harbor-web.
    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
    world.repoStatus['harbor-web'] = 404
    const second = await scan(1)
    expect(second.status).toBe('partial')
    expect(second.errors).toEqual([
      expect.objectContaining({ source: 'github', subject: 'kestrel-co/harbor-web' }),
    ])
    expect(repos.findings.get(id)).toMatchObject({ state: 'open', reportedBy: ['github'] })
    expect(repos.sources.listByKind('github')[0]?.lastError).toMatch(/1 of 3 failed/)
    expect(repos.scanRuns.get(second.scanRunId)?.sourceResults.github?.status).toBe('error')

    // Day 2: GitHub answers again and does not report it either.
    world.repoStatus['harbor-web'] = 200
    world.githubAlerts['harbor-web'] = []
    const third = await scan(2)
    expect(third.status).toBe('succeeded')
    expect(repos.findings.get(id)).toMatchObject({ state: 'fixed' })
    expect(third.changes).toContainEqual({ findingId: id, change: 'fixed' })
    expect(repos.sources.listByKind('github')[0]?.lastError).toBeNull()

    // Day 3: a rollback brings it back.
    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.0' }
    const fourth = await scan(3)
    expect(repos.findings.get(id)).toMatchObject({ state: 'open', fixedAt: null })
    expect(fourth.changes).toContainEqual({ findingId: id, change: 'reopened' })
    expect(
      repos.findings
        .listEvents(id)
        .map((e) => e.type)
        .reverse(),
    ).toEqual(['opened', 'reporters_changed', 'fixed', 'reopened'])
  })

  it('resolves a blind spot when its condition clears', async () => {
    await scan(0)
    const key = `blind:lockfile_missing:repo:${repoId('dock-worker')}`
    expect(repos.findings.getByKey(key)?.state).toBe('open')

    world.lockfiles['dock-worker'] = { 'example-left-pad': '1.0.0' }
    world.alertsStatus['lantern-api'] = 204
    const summary = await scan(1)
    expect(repos.findings.getByKey(key)?.state).toBe('fixed')
    expect(repos.findings.listEvents(repos.findings.getByKey(key)!.id)[0]?.type).toBe('resolved')
    expect(blindSpots()).toEqual([
      'alerts_disabled:fixed',
      'lockfile_missing:fixed',
      'no_repo_mapping:open',
    ])
    expect(summary.findingsFixed).toBe(2)

    // A manual override maps legacy-cron to a repo: its blind spot resolves too.
    const cron = repos.deployments.list().find((d) => d.name === 'legacy-cron')!
    repos.deployments.addRepoOverride(cron.id, repoId('harbor-web'), 'cron ships from harbor-web')
    await scan(2)
    expect(blindSpots()).toContain('no_repo_mapping:fixed')
  })

  it('moves an image only deployment from a blind spot to a coverage note', async () => {
    await scan(0)
    const docs = repos.deployments.list().find((d) => d.name === 'static-docs')!
    // What an earlier version stored: a no_repo_mapping blind spot on the image only app.
    const old = repos.findings.observe(
      { kind: 'blind_spot', blindSpotType: 'no_repo_mapping', deploymentId: docs.id },
      new Date(t0),
    ).finding
    const summary = await scan(1)
    expect(repos.findings.get(old.id)?.state).toBe('fixed')
    expect(repos.findings.listEvents(old.id)[0]).toMatchObject({
      type: 'resolved',
      data: { reason: 'reclassified', as: 'image_only' },
    })
    expect(summary.changes).toContainEqual({ findingId: old.id, change: 'fixed' })

    // The note ranks below every advisory, and a mapping clears it.
    const ranked = listRankedFindings(repos).filter((r) => r.state !== 'fixed')
    expect(ranked.at(-1)).toMatchObject({ kind: 'coverage_note' })
    const note = ranked.at(-1)!.finding
    repos.deployments.addRepoOverride(docs.id, repoId('harbor-web'), 'docs ship from harbor-web')
    await scan(2)
    expect(repos.findings.get(note.id)).toMatchObject({ state: 'fixed' })
    expect(repos.findings.listEvents(note.id)[0]?.type).toBe('resolved')
  })

  it('keeps blind spots untouched when the check could not run', async () => {
    await scan(0)
    world.repoStatus['lantern-api'] = 404
    await scan(1)
    expect(blindSpots()).toContain('alerts_disabled:open')
  })

  it('records a failed source without aborting the scan', async () => {
    const coolify = repos.sources.listByKind('coolify')[0]!
    repos.sources.update(coolify.id, { baseUrl: 'https://unreachable.example.dev' })
    const summary = await scan(0)
    expect(summary.sourceResults.coolify?.status).toBe('error')
    expect(repos.sources.get(coolify.id)?.lastError).toMatch(/Could not reach Coolify/)
    // Nothing is deployed, so there is nothing to scan; the run is still recorded.
    expect(summary.status).toBe('failed')
    expect(repos.scanRuns.get(summary.scanRunId)?.finishedAt).not.toBeNull()
  })

  it('skips OSV when it is switched off', async () => {
    repos.settings.set(SCAN_SETTING_KEYS.osvEnabled, false)
    const summary = await scan(0)
    expect(summary.sourceResults.osv).toEqual({ status: 'skipped', counts: {} })
    expect(repos.advisories.findByAnyId('GHSA-la00-0000-0002')).toEqual([])
    expect(blindSpots()).not.toContain('lockfile_missing:open')
  })

  it('opens no lockfile or alert blind spots while GitHub is not connected', async () => {
    repos.sources.remove(repos.sources.listByKind('github')[0]!.id)
    const summary = await scan(0)
    expect(summary.sourceResults.github).toEqual({ status: 'skipped', counts: {} })
    const types = repos.findings.list({ kind: 'blind_spot' }).map((f) => f.blindSpotType)
    expect(types).not.toContain('lockfile_missing')
    expect(types).not.toContain('alerts_unknown')
    expect(types).not.toContain('alerts_disabled')

    // An open one from an earlier scan is left alone, not resolved.
    repos.sources.create({ kind: 'github', name: 'kestrel-co', token: 'github-token' })
    await scan(1)
    const key = `blind:lockfile_missing:repo:${repoId('dock-worker')}`
    expect(repos.findings.getByKey(key)?.state).toBe('open')
    repos.sources.remove(repos.sources.listByKind('github')[0]!.id)
    await scan(2)
    expect(repos.findings.getByKey(key)?.state).toBe('open')
  })

  it('reopens expired snoozes and lists what changed since the previous scan', async () => {
    const first = await scan(0)
    const id = advisoryFinding('lantern-api', 'GHSA-la00-0000-0002')!.id
    repos.findings.changeState(
      id,
      { state: 'snoozed', reason: 'patch scheduled', until: new Date(t0 + day / 2), actor: 'user' },
      new Date(t0 + 1000),
    )
    const second = await scan(1)
    expect(second.changes).toContainEqual({ findingId: id, change: 'expired' })
    expect(repos.findings.get(id)?.state).toBe('open')

    const changed = findingChangesSince(repos, second.startedAt)
    expect(changed.map((c) => c.finding.id)).toEqual([id])
    expect(changed[0]!.events.map((e) => e.type)).toEqual(['snooze_expired'])
    expect(findingChangesSince(repos, first.startedAt).length).toBe(6)
  })

  describe('dismissed on GitHub', () => {
    const HW = 'GHSA-hw00-0000-0001'
    const dismissal = { ghsa: HW, reason: 'tolerable_risk', comment: 'only used by the test suite' }

    it('stays open with a note while OSV still reports it', async () => {
      await scan(0)
      const id = advisoryFinding('harbor-web', HW)!.id
      world.githubAlerts['harbor-web'] = []
      world.githubDismissed['harbor-web'] = [dismissal]
      const summary = await scan(1)
      expect(repos.findings.get(id)).toMatchObject({ state: 'open', reportedBy: ['osv'] })
      expect(summary.changes).not.toContainEqual({ findingId: id, change: 'fixed' })
      const notes = repos.findings.listEvents(id).filter((e) => e.type === 'dismissal_noted')
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({
        actor: 'system',
        data: { reason: 'tolerable_risk', comment: 'only used by the test suite' },
      })
      // The same dismissal is noted once, not on every scan.
      await scan(2)
      expect(
        repos.findings.listEvents(id).filter((e) => e.type === 'dismissal_noted'),
      ).toHaveLength(1)
    })

    it('becomes dismissed_upstream, never fixed, and reopens when GitHub reopens it', async () => {
      await scan(0)
      const id = advisoryFinding('harbor-web', HW)!.id
      world.githubAlerts['harbor-web'] = []
      world.githubDismissed['harbor-web'] = [dismissal]
      world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
      const second = await scan(1)
      expect(repos.findings.get(id)).toMatchObject({
        state: 'dismissed_upstream',
        stateReason: 'tolerable_risk',
        fixedAt: null,
      })
      expect(second.changes).toContainEqual({ findingId: id, change: 'dismissed_upstream' })
      expect(second.changes).not.toContainEqual({ findingId: id, change: 'fixed' })
      expect(second.findingsFixed).toBe(0)
      expect(repos.findings.listEvents(id)[0]).toMatchObject({
        type: 'dismissed_upstream',
        actor: 'system',
        toState: 'dismissed_upstream',
        reason: 'tolerable_risk',
        data: {
          reason: 'tolerable_risk',
          comment: 'only used by the test suite',
          dismissedAt: '2026-10-20T08:00:00Z',
        },
      })

      // Not exposed and no action needed, but still listed with its state.
      const counts = findingCounts(repos, new Date(t0 + day)).advisories
      expect(counts).toMatchObject({ total: 2, dismissedUpstream: 1, exposed: 1, needsAction: 1 })
      expect(listRankedFindings(repos).find((r) => r.finding.id === id)?.state).toBe(
        'dismissed_upstream',
      )

      // A later scan keeps it as is.
      const third = await scan(2)
      expect(repos.findings.get(id)?.state).toBe('dismissed_upstream')
      expect(third.changes).not.toContainEqual(expect.objectContaining({ findingId: id }))

      // GitHub reopens the alert.
      world.githubDismissed['harbor-web'] = []
      world.githubAlerts['harbor-web'] = [HW]
      const fourth = await scan(3)
      expect(repos.findings.get(id)).toMatchObject({ state: 'open', stateReason: null })
      expect(fourth.changes).toContainEqual({ findingId: id, change: 'reopened' })
      expect(repos.findings.listEvents(id)[0]).toMatchObject({
        type: 'reopened',
        actor: 'system',
        data: { reason: 'reopened_upstream' },
      })
    })

    it('reopens a dismissed finding when OSV starts reporting it', async () => {
      world.githubAlerts['harbor-web'] = []
      world.githubDismissed['harbor-web'] = [dismissal]
      world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
      await scan(0)
      const id = advisoryFinding('harbor-web', HW)!.id
      expect(repos.findings.get(id)?.state).toBe('dismissed_upstream')

      world.lockfiles['harbor-web'] = { 'example-parser': '1.2.0' }
      await scan(1)
      expect(repos.findings.get(id)).toMatchObject({ state: 'open', reportedBy: ['osv'] })
      const reopened = repos.findings.listEvents(id).find((e) => e.type === 'reopened')
      expect(reopened?.data).toEqual({ reason: 'still_reported' })
    })

    it('records a dismissal of an advisory that was never open, and keeps a snooze', async () => {
      world.githubDismissed['dock-worker'] = [
        { ghsa: 'GHSA-la00-0000-0002', reason: 'not_used', comment: '' },
      ]
      await scan(0)
      const old = advisoryFinding('dock-worker', 'GHSA-la00-0000-0002')!
      expect(old).toMatchObject({ state: 'dismissed_upstream', reportedBy: ['github'] })

      // A user's snooze is not overridden by the upstream dismissal.
      await scan(1)
      repos.findings.changeState(
        old.id,
        { state: 'snoozed', reason: 'later', until: new Date(t0 + 5 * day), actor: 'user' },
        new Date(t0 + 1 * day),
      )
      await scan(2)
      expect(repos.findings.get(old.id)?.state).toBe('snoozed')
    })

    it('stays open when OSV reported it before and could not look this time', async () => {
      await scan(0)
      const id = advisoryFinding('harbor-web', HW)!.id
      world.githubAlerts['harbor-web'] = []
      world.githubDismissed['harbor-web'] = [dismissal]
      world.lockfiles['harbor-web'] = null
      await scan(1)
      expect(repos.findings.get(id)?.state).toBe('open')
    })
  })

  describe('stopped apps', () => {
    it('ranks a stopped app as not deployed but keeps the stopped marker', async () => {
      await scan(0)
      const id = advisoryFinding('harbor-web', 'GHSA-hw00-0000-0001')!.id
      const view = () => listRankedFindings(repos).find((r) => r.finding.id === id)!
      expect(view()).toMatchObject({ reach: 'public', stopped: false })

      world.appStatus['harbor-web'] = 'exited:unhealthy'
      await scan(1)
      expect(view()).toMatchObject({ reach: 'none', stopped: true })
      expect(view().factors).toMatchObject({ deployed: false, public: false })
      expect(view().rank).toBeLessThan(10)
      expect(repos.findings.get(id)?.state).toBe('open')
      expect(findingCounts(repos, new Date(t0 + day)).advisories.exposed).toBe(1)

      world.appStatus['harbor-web'] = 'restarting:unhealthy'
      await scan(2)
      expect(view()).toMatchObject({ reach: 'public', stopped: false })
    })
  })

  describe('OSV switched off', () => {
    it('resolves lockfile blind spots as not checked', async () => {
      await scan(0)
      const key = `blind:lockfile_missing:repo:${repoId('dock-worker')}`
      expect(repos.findings.getByKey(key)?.state).toBe('open')

      repos.settings.set(SCAN_SETTING_KEYS.osvEnabled, false)
      const summary = await scan(1)
      const finding = repos.findings.getByKey(key)!
      expect(finding.state).toBe('fixed')
      expect(repos.findings.listEvents(finding.id)[0]).toMatchObject({
        type: 'resolved',
        actor: 'system',
        data: { checked: false, reason: 'osv_disabled' },
      })
      expect(summary.changes).toContainEqual({ findingId: finding.id, change: 'fixed' })

      // Switching OSV back on brings the blind spot back.
      repos.settings.set(SCAN_SETTING_KEYS.osvEnabled, true)
      await scan(2)
      expect(repos.findings.getByKey(key)?.state).toBe('open')
    })
  })
})

describe('alerts GitHub keeps open although the lockfile is patched', () => {
  const GHSA = 'GHSA-hw00-0000-0001'

  it('flags the finding, ranks it below every advisory and keeps it out of the counts', async () => {
    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
    await scan(0)
    const finding = advisoryFinding('harbor-web', GHSA)!
    expect(finding).toMatchObject({
      state: 'open',
      reportedBy: ['github'],
      installedVersion: '1.2.5',
      patchedInLockfile: true,
    })
    const ranked = listRankedFindings(repos)
    const row = ranked.find((r) => r.finding.id === finding.id)!
    expect(row.patchedInLockfile).toBe(true)
    expect(tierOf(row)).toBe('patched')
    const advisoryRanks = ranked
      .filter((r) => r.kind === 'advisory' && !r.patchedInLockfile)
      .map((r) => r.rank)
    expect(row.rank).toBeLessThan(Math.min(...advisoryRanks))
    // Only the critical on lantern-api is left in the funnel.
    expect(findingCounts(repos, new Date(t0)).advisories).toMatchObject({
      total: 1,
      exposed: 1,
      needsAction: 1,
    })
  })

  it('falls back to the first patched version when GitHub sent no range', async () => {
    world.blankRange = true
    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
    await scan(0)
    expect(advisoryFinding('harbor-web', GHSA)).toMatchObject({
      installedVersion: '1.2.5',
      patchedInLockfile: true,
    })
  })

  it('stays exposed when the lockfile is still vulnerable, with or without a range', async () => {
    for (const blank of [false, true]) {
      world.blankRange = blank
      world.lockfiles['harbor-web'] = { 'example-parser': '1.2.0' }
      await scan(blank ? 1 : 0)
      expect(advisoryFinding('harbor-web', GHSA)).toMatchObject({
        installedVersion: '1.2.0',
        patchedInLockfile: false,
      })
    }
  })

  it('flips an existing finding on the next scan, and back when it regresses', async () => {
    await scan(0)
    expect(advisoryFinding('harbor-web', GHSA)).toMatchObject({ patchedInLockfile: false })

    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.5' }
    await scan(1)
    expect(advisoryFinding('harbor-web', GHSA)).toMatchObject({
      state: 'open',
      installedVersion: '1.2.5',
      patchedInLockfile: true,
    })

    world.lockfiles['harbor-web'] = { 'example-parser': '1.2.0' }
    await scan(2)
    expect(advisoryFinding('harbor-web', GHSA)).toMatchObject({ patchedInLockfile: false })
  })
})
