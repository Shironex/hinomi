import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SecretDecryptError, SecretKeyMissingError } from '../crypto/secret-box.js'
import { createTestRepositories } from '../db/test-db.js'
import type { DatabaseHandle } from '../db/client.js'
import { deploymentInputFromRecord, type Repositories } from './index.js'
import { nowMs } from '@hinomi/shared'

const TOKEN = 'fictional-token-0000000000'
let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

function seedDeployment(name = 'shop-web') {
  const source = repos.sources.create({
    kind: 'coolify',
    name: 'edge',
    baseUrl: 'https://coolify.example.dev',
  })
  const repo = repos.repos.upsert({ owner: 'Kestrel-Co', name: 'Shop', defaultBranch: 'main' })
  const deployment = repos.deployments.upsert({
    sourceId: source.id,
    externalId: `uuid-${name}`,
    kind: 'application',
    name,
    domains: ['shop.example.dev'],
    reach: 'public',
    server: 'edge-1',
    gitRepository: 'kestrel-co/shop',
    gitBranch: 'main',
    repoId: repo.id,
  })
  return { source, repo, deployment }
}

describe('sources', () => {
  it('stores tokens encrypted and only exposes hasToken', () => {
    const source = repos.sources.create({ kind: 'github', name: 'kestrel-co', token: TOKEN })
    expect(source.hasToken).toBe(true)
    expect(JSON.stringify(source)).not.toContain(TOKEN)
    expect(source).not.toHaveProperty('tokenEncrypted')
    expect(JSON.stringify(repos.sources.list())).not.toContain(TOKEN)

    const raw = handle.sqlite.prepare('select token_encrypted from sources').pluck().get()
    expect(raw).toMatch(/^v1\./)
    expect(raw).not.toContain(TOKEN)
    expect(repos.sources.getToken(source.id)).toBe(TOKEN)

    repos.sources.clearToken(source.id)
    expect(repos.sources.get(source.id)?.hasToken).toBe(false)
    expect(repos.sources.getToken(source.id)).toBeNull()
  })

  it('updates, records health and removes', () => {
    const source = repos.sources.create({ kind: 'osv', name: 'osv.dev' })
    expect(source.enabled).toBe(true)
    expect(repos.sources.update(source.id, { enabled: false })?.enabled).toBe(false)
    repos.sources.markError(source.id, 'timeout', new Date(1000))
    expect(repos.sources.get(source.id)).toMatchObject({
      lastError: 'timeout',
      lastErrorAt: new Date(1000),
    })
    repos.sources.markOk(source.id, new Date(2000))
    expect(repos.sources.get(source.id)).toMatchObject({
      lastError: null,
      lastOkAt: new Date(2000),
    })
    expect(repos.sources.listByKind('osv')).toHaveLength(1)
    expect(repos.sources.remove(source.id)).toBe(true)
    expect(repos.sources.list()).toEqual([])
  })

  it('refuses to store a token without HINOMI_SECRET_KEY but still works otherwise', () => {
    const test = createTestRepositories({ withSecret: false })
    try {
      const sources = test.repos.sources
      expect(sources.canStoreTokens).toBe(false)
      expect(() => sources.create({ kind: 'github', name: 'kestrel-co', token: TOKEN })).toThrow(
        SecretKeyMissingError,
      )
      const source = sources.create({ kind: 'github', name: 'kestrel-co' })
      expect(() => sources.setToken(source.id, TOKEN)).toThrow(SecretKeyMissingError)
      expect(sources.get(source.id)?.hasToken).toBe(false)
    } finally {
      test.handle.close()
    }
  })

  it('reports a tampered stored token', () => {
    const source = repos.sources.create({ kind: 'github', name: 'kestrel-co', token: TOKEN })
    handle.sqlite
      .prepare("update sources set token_encrypted = 'v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'")
      .run()
    expect(() => repos.sources.getToken(source.id)).toThrow(SecretDecryptError)
  })
})

describe('repos', () => {
  it('upserts by lowercased owner/name and keeps fields that are not given', () => {
    const first = repos.repos.upsert({ owner: 'Kestrel-Co', name: 'Shop', defaultBranch: 'main' })
    expect(first).toMatchObject({
      owner: 'kestrel-co',
      name: 'shop',
      archived: false,
      alertsEnabled: null,
    })
    const second = repos.repos.upsert({ owner: 'kestrel-co', name: 'SHOP', alertsEnabled: false })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ defaultBranch: 'main', alertsEnabled: false })
    repos.repos.markScanned(first.id, new Date(5000))
    expect(repos.repos.getByName('KESTREL-CO', 'shop')?.lastScannedAt).toEqual(new Date(5000))
    expect(repos.repos.list()).toHaveLength(1)
  })
})

describe('deployments', () => {
  it('upserts by source and external id, keeping firstSeenAt', () => {
    const { source, deployment } = seedDeployment()
    expect(deployment.domains).toEqual(['shop.example.dev'])
    const again = repos.deployments.upsert(
      { sourceId: source.id, externalId: 'uuid-shop-web', kind: 'application', name: 'shop-web-2' },
      new Date(nowMs() + 60_000),
    )
    expect(again.id).toBe(deployment.id)
    expect(again.name).toBe('shop-web-2')
    expect(again.firstSeenAt).toEqual(deployment.firstSeenAt)
    expect(again.lastSeenAt.getTime()).toBeGreaterThan(deployment.lastSeenAt.getTime())
    expect(repos.deployments.listBySource(source.id)).toHaveLength(1)
  })

  it('removes deployments the source no longer reports', () => {
    const { source } = seedDeployment('a')
    repos.deployments.upsert({
      sourceId: source.id,
      externalId: 'uuid-b',
      kind: 'service',
      name: 'b',
    })
    expect(repos.deployments.removeMissing(source.id, ['uuid-a'])).toBe(1)
    expect(repos.deployments.list().map((d) => d.externalId)).toEqual(['uuid-a'])
    expect(repos.deployments.removeMissing(source.id, [])).toBe(1)
  })

  it('honours manual repo overrides over the automatic mapping', () => {
    const { repo, deployment } = seedDeployment()
    const api = repos.repos.upsert({ owner: 'kestrel-co', name: 'monorepo' })
    expect(repos.deployments.effectiveRepoIds(deployment.id)).toEqual([repo.id])
    expect(repos.deployments.listByRepo(repo.id).map((d) => d.id)).toEqual([deployment.id])

    repos.deployments.addRepoOverride(deployment.id, api.id, 'lives in the monorepo')
    expect(repos.deployments.effectiveRepoIds(deployment.id)).toEqual([api.id])
    expect(repos.deployments.listByRepo(repo.id)).toEqual([])
    expect(repos.deployments.listByRepo(api.id).map((d) => d.id)).toEqual([deployment.id])
    expect(repos.deployments.listRepoOverrides(deployment.id)[0]?.note).toBe(
      'lives in the monorepo',
    )

    expect(repos.deployments.removeRepoOverride(deployment.id, api.id)).toBe(true)
    expect(repos.deployments.effectiveRepoIds(deployment.id)).toEqual([repo.id])
  })

  it('maps a normalised deployment record', () => {
    const source = repos.sources.create({ kind: 'coolify', name: 'main' })
    const input = deploymentInputFromRecord(
      {
        source: 'main',
        externalId: 'uuid-api',
        name: 'api',
        kind: 'application',
        repo: 'kestrel-co/api',
        branch: 'main',
        domains: ['https://api.example.dev'],
        isPublic: true,
        server: 'edge-1',
        status: 'running:healthy',
        image: null,
        lastDeployAt: '2026-10-01T12:00:00.000Z',
        watchPaths: ['apps/api/**'],
      },
      source.id,
    )
    const row = repos.deployments.upsert(input)
    expect(row).toMatchObject({
      kind: 'application',
      reach: 'public',
      gitRepository: 'kestrel-co/api',
      watchPaths: ['apps/api/**'],
      lastDeployedAt: new Date('2026-10-01T12:00:00.000Z'),
      repoId: null,
    })
  })

  it('cascades when the source is removed', () => {
    const { source } = seedDeployment()
    repos.sources.remove(source.id)
    expect(repos.deployments.list()).toEqual([])
  })
})

describe('advisories', () => {
  it('upserts per advisory and package, and finds by any id', () => {
    const advisory = repos.advisories.upsert({
      advisoryKey: 'GHSA-xxxx-yyyy-zzzz',
      ghsaId: 'GHSA-xxxx-yyyy-zzzz',
      cveIds: ['CVE-2099-0001'],
      aliases: ['OSV-2099-1'],
      ecosystem: 'npm',
      packageName: 'left-pad',
      severity: 'high',
      cvssScore: 8.1,
      vulnerableRanges: ['< 1.3.1'],
      firstPatchedVersion: '1.3.1',
    })
    const updated = repos.advisories.upsert({
      advisoryKey: 'GHSA-xxxx-yyyy-zzzz',
      ecosystem: 'npm',
      packageName: 'left-pad',
      severity: 'critical',
    })
    expect(updated.id).toBe(advisory.id)
    expect(updated.severity).toBe('critical')
    for (const id of ['GHSA-xxxx-yyyy-zzzz', 'CVE-2099-0001', 'OSV-2099-1']) {
      expect(repos.advisories.findByAnyId(id).map((a) => a.id)).toEqual([advisory.id])
    }
    expect(repos.advisories.findByAnyId('CVE-2099-9999')).toEqual([])
  })
})

describe('findings', () => {
  function seedAdvisory() {
    return repos.advisories.upsert({
      advisoryKey: 'GHSA-aaaa-bbbb-cccc',
      ecosystem: 'npm',
      packageName: 'example-lib',
    })
  }

  it('creates on first observation and merges reporters after', () => {
    const { repo } = seedDeployment()
    const advisory = seedAdvisory()
    const first = repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: advisory.id,
        repoId: repo.id,
        scope: 'runtime',
        reportedBy: ['github'],
        manifestPaths: ['package.json'],
      },
      new Date(1000),
    )
    expect(first.created).toBe(true)
    expect(first.finding).toMatchObject({ state: 'open', scope: 'runtime', reportedBy: ['github'] })

    const second = repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: advisory.id,
        repoId: repo.id,
        reportedBy: ['osv', 'github'],
        manifestPaths: ['apps/web/package.json'],
      },
      new Date(2000),
    )
    expect(second.created).toBe(false)
    expect(second.finding.id).toBe(first.finding.id)
    expect(second.finding.reportedBy).toEqual(['github', 'osv'])
    expect(second.finding.manifestPaths).toEqual(['package.json', 'apps/web/package.json'])
    expect(second.finding.firstSeenAt).toEqual(new Date(1000))
    expect(second.finding.lastSeenAt).toEqual(new Date(2000))

    expect(repos.findings.list({ repoId: repo.id, state: 'open' })).toHaveLength(1)
    expect(repos.findings.listEvents(first.finding.id).map((e) => e.type)).toEqual(['opened'])
  })

  it('tracks blind spots per subject', () => {
    const { repo, deployment } = seedDeployment()
    const onRepo = repos.findings.observe({
      kind: 'blind_spot',
      blindSpotType: 'alerts_disabled',
      repoId: repo.id,
    })
    const onDeployment = repos.findings.observe({
      kind: 'blind_spot',
      blindSpotType: 'no_repo_mapping',
      deploymentId: deployment.id,
    })
    expect(onRepo.finding.dedupeKey).toBe(`blind:alerts_disabled:repo:${repo.id}`)
    expect(onDeployment.finding.dedupeKey).toBe(`blind:no_repo_mapping:deployment:${deployment.id}`)
    expect(repos.findings.list({ kind: 'blind_spot' })).toHaveLength(2)
  })

  it('writes a history event for every state change', () => {
    const { repo } = seedDeployment()
    const { finding } = repos.findings.observe(
      {
        kind: 'advisory',
        advisoryId: seedAdvisory().id,
        repoId: repo.id,
        reportedBy: ['github'],
      },
      new Date(1000),
    )

    const snoozed = repos.findings.changeState(
      finding.id,
      { state: 'snoozed', reason: 'waiting for upstream', until: new Date(9000), actor: 'user' },
      new Date(3000),
    )
    expect(snoozed).toMatchObject({
      state: 'snoozed',
      stateReason: 'waiting for upstream',
      stateUntil: new Date(9000),
    })

    const fixed = repos.findings.changeState(
      finding.id,
      { state: 'fixed', actor: 'system', eventType: 'fixed' },
      new Date(4000),
    )
    expect(fixed).toMatchObject({ state: 'fixed', fixedAt: new Date(4000), stateReason: null })

    const reopened = repos.findings.changeState(
      finding.id,
      { state: 'open', actor: 'system', eventType: 'reopened' },
      new Date(5000),
    )
    expect(reopened.fixedAt).toBeNull()

    const events = repos.findings.listEvents(finding.id)
    expect(events.map((e) => [e.type, e.fromState, e.toState, e.actor])).toEqual([
      ['reopened', 'fixed', 'open', 'system'],
      ['fixed', 'snoozed', 'fixed', 'system'],
      ['state_changed', 'open', 'snoozed', 'user'],
      ['opened', null, 'open', 'system'],
    ])
  })

  it('refuses to change the state of a missing finding', () => {
    expect(() => repos.findings.changeState(999, { state: 'fixed', actor: 'system' })).toThrow(
      /does not exist/,
    )
  })
})

describe('scan runs', () => {
  it('starts, finishes and lists runs', () => {
    const run = repos.scanRuns.start('manual', new Date(1000))
    expect(run.status).toBe('running')
    expect(repos.scanRuns.running()?.id).toBe(run.id)

    const done = repos.scanRuns.finish(
      run.id,
      {
        status: 'partial',
        sourceResults: {
          coolify: { status: 'ok', counts: { deployments: 4 }, durationMs: 120 },
          github: { status: 'error', counts: {}, error: 'rate limited' },
        },
        findingsOpened: 2,
      },
      new Date(4500),
    )
    expect(done).toMatchObject({
      status: 'partial',
      durationMs: 3500,
      findingsOpened: 2,
      findingsFixed: 0,
    })
    expect(done?.sourceResults.github?.error).toBe('rate limited')
    expect(repos.scanRuns.running()).toBeUndefined()

    const later = repos.scanRuns.start('schedule', new Date(9000))
    expect(repos.scanRuns.latest()?.id).toBe(later.id)
    expect(repos.scanRuns.list().map((r) => r.id)).toEqual([later.id, run.id])
    expect(repos.scanRuns.finish(12345, { status: 'failed', sourceResults: {} })).toBeUndefined()
  })
})

describe('settings', () => {
  it('stores JSON values and validates on read', () => {
    const interval = z.number().int().positive()
    expect(repos.settings.get('scan.intervalHours', interval)).toBeUndefined()
    repos.settings.set('scan.intervalHours', 6)
    expect(repos.settings.get('scan.intervalHours', interval)).toBe(6)
    repos.settings.set('scan.intervalHours', 12)
    repos.settings.set('notify.discord', { enabled: false })
    expect(repos.settings.all()).toEqual({
      'notify.discord': { enabled: false },
      'scan.intervalHours': 12,
    })
    repos.settings.set('scan.intervalHours', 'oops')
    expect(repos.settings.get('scan.intervalHours', interval)).toBeUndefined()
    expect(repos.settings.remove('scan.intervalHours')).toBe(true)
  })
})
