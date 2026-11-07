import { guardEvidenceSchema, type LockfileDependency } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../../db/client.js'
import type { RepoRow } from '../../db/schema.js'
import { createTestRepositories } from '../../db/test-db.js'
import type { Repositories } from '../../repository/index.js'
import { createSupportIndex, parseProductsFull } from '../../support/index.js'
import { bodyOf } from '../../support/testing.js'
import type { RepoScan } from '../collect.js'
import { indexDeployments } from '../deployments.js'
import { runGuards } from './run.js'
import { frameworkSupportGuard } from './framework-support.js'
import type { GuardContext } from './types.js'

// Fictional repos (kestrel-co) against hand written endoflife.date products, "now" 2026-11-08.

const NOW = new Date('2026-11-08T10:00:00Z')

function release(name: string, over: Record<string, unknown> = {}) {
  return {
    name,
    label: name,
    releaseDate: '2024-01-01',
    isLts: false,
    ltsFrom: null,
    isEoas: false,
    eoasFrom: null,
    isEol: false,
    eolFrom: null,
    latest: { name: `${name}.9`, date: '2026-10-01' },
    ...over,
  }
}

function product(
  name: string,
  purl: string,
  eol: string,
  releases: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    label: name,
    aliases: [],
    category: 'framework',
    labels: { eol },
    identifiers: [{ type: 'purl', id: purl }],
    releases,
    ...extra,
  }
}

const support = createSupportIndex(
  parseProductsFull(
    bodyOf(
      product('nextjs', 'pkg:npm/next', 'Security Support', [
        release('16', { latest: { name: '16.4.5', date: '2026-10-01' } }),
        release('15', { eolFrom: '2027-01-31' }),
        release('14', { eolFrom: '2025-10-26', isEol: true }),
      ]),
      product('django', 'pkg:pypi/django', 'Security Support', [
        release('6.2', { eolFrom: '2029-04-01' }),
        release('6.1', { eolFrom: '2027-01-20' }),
        release('6', { eolFrom: '2026-04-01', isEol: true }),
      ]),
      product('angular', 'pkg:npm/%40angular/core', 'Security Support', [
        release('21'),
        release('20', { eolFrom: '2026-05-19', isEol: true }),
      ]),
      product('express', 'pkg:npm/express', 'Security Support', [
        release('5', { isEoas: true, eoasFrom: '2026-01-01', eolFrom: '2030-01-01' }),
      ]),
      // No "security" in the end label: its dates are release cycle dates.
      product('kestrelkit', 'pkg:npm/kestrelkit', 'Supported', [
        release('3'),
        release('2', { eolFrom: '2026-06-01', isEol: true }),
      ]),
    ),
  ),
)

let handle: DatabaseHandle
let repos: Repositories
let repo: RepoRow

beforeEach(() => {
  ;({ handle, repos } = createTestRepositories())
  repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'kestrel-web' })
})
afterEach(() => handle.close())

function dep(name: string, version: string, over: Partial<LockfileDependency> = {}) {
  return {
    name,
    version,
    ecosystem: 'npm',
    scope: 'runtime',
    direct: true,
    lockfile: 'pnpm-lock.yaml',
    ...over,
  } satisfies LockfileDependency
}

function ctxFor(
  dependencies: LockfileDependency[] | null,
  over: Partial<GuardContext> = {},
): GuardContext {
  const scan: RepoScan = {
    repo,
    deployed: false,
    health: { status: 'skipped', reason: 'test' },
    alerts: { status: 'skipped', reason: 'test' },
    osv:
      dependencies === null
        ? { status: 'skipped', reason: 'OSV is switched off' }
        : {
            status: 'ok',
            value: { matches: [], lockfiles: ['pnpm-lock.yaml'], unparseable: [], dependencies },
          },
  }
  const index = indexDeployments(repos)
  return {
    deployments: index.deployments,
    repos: [repo],
    index,
    scans: new Map([[repo.id, scan]]),
    support,
    supportWindowDays: 90,
    now: NOW,
    ...over,
  }
}

async function run(dependencies: LockfileDependency[] | null, over: Partial<GuardContext> = {}) {
  const results = await frameworkSupportGuard.run(ctxFor(dependencies, over))
  expect(results.length).toBeLessThanOrEqual(1)
  const result = results[0]
  const evidence =
    result && result.level !== null && result.evidence !== undefined
      ? guardEvidenceSchema.parse(result.evidence)
      : null
  const frameworks = evidence?.check === 'framework_support' ? evidence.frameworks : []
  return { result, evidence, frameworks }
}

describe('framework_support', () => {
  it('warns for next 15 inside the window and points at the supported line', async () => {
    const { result, frameworks, evidence } = await run([dep('next', '15.5.29')])
    expect(result?.level).toBe('warn')
    expect(result?.subject).toEqual({ repoId: repo.id })
    expect(frameworks).toEqual([
      {
        packageName: 'next',
        ecosystem: 'npm',
        purl: 'pkg:npm/next',
        installedVersion: '15.5.29',
        manifestPath: null,
        result: 'warn',
        support: {
          product: 'nextjs',
          line: '15',
          eolFrom: '2027-01-31',
          isEol: false,
          isEoas: false,
          latest: '15.9',
          basis: 'security',
          daysLeft: 83,
        },
        target: { line: '16', latest: '16.4.5' },
      },
    ])
    expect(evidence && 'reason' in evidence && evidence.reason).toBeNull()
  })

  it('fails for next 14, which is past end of security support', async () => {
    const { result, frameworks } = await run([dep('next', '14.2.35')])
    expect(result?.level).toBe('fail')
    expect(frameworks[0]?.support?.isEol).toBe(true)
    expect(frameworks[0]?.target?.line).toBe('16')
  })

  it('matches django 6.1.3 to line 6.1, not 6', async () => {
    const { result, frameworks } = await run([dep('Django', '6.1.3', { ecosystem: 'PyPI' })])
    expect(result?.level).toBe('warn')
    expect(frameworks[0]?.support?.line).toBe('6.1')
    expect(frameworks[0]?.purl).toBe('pkg:pypi/django')
    expect(frameworks[0]?.target?.line).toBe('6.2')
  })

  it('handles scoped purls (@angular/core)', async () => {
    const { result, frameworks } = await run([dep('@angular/core', '20.3.1')])
    expect(result?.level).toBe('fail')
    expect(frameworks[0]).toMatchObject({
      packageName: '@angular/core',
      purl: 'pkg:npm/@angular/core',
    })
  })

  it('names the workspace manifest of an npm dependency', async () => {
    const { frameworks } = await run([
      dep('next', '16.4.5', { lockfile: 'pnpm-lock.yaml', workspaces: ['apps/web'] }),
    ])
    expect(frameworks[0]?.manifestPath).toBe('apps/web/package.json')
  })

  it('ignores a dev only match', async () => {
    const { result, frameworks } = await run([dep('next', '14.2.35', { scope: 'dev' })])
    expect(frameworks).toEqual([])
    expect(result).toEqual({ subject: { repoId: repo.id }, level: 'pass' })
  })

  it('ignores a transitive match', async () => {
    const { result, frameworks } = await run([
      dep('next', '14.2.35', { direct: false, path: ['kestrel-ui', 'next'] }),
    ])
    expect(frameworks).toEqual([])
    expect(result?.level).toBe('pass')
  })

  it('keeps a dependency whose scope the lockfile cannot tell', async () => {
    const { result } = await run([dep('next', '14.2.35', { scope: 'unknown' })])
    expect(result?.level).toBe('fail')
  })

  it('is unknown when the version matches no release line', async () => {
    const { result, frameworks, evidence } = await run([dep('next', '99.0.0')])
    expect(result?.level).toBe('unknown')
    expect(frameworks[0]).toMatchObject({ result: 'unknown', support: null, target: null })
    expect(evidence && 'reason' in evidence && evidence.reason).toMatch(/no release line/)
  })

  it('passes a maintained line, and keeps end of active support from raising a level', async () => {
    const { result, frameworks } = await run([dep('express', '5.1.0'), dep('next', '16.4.5')])
    expect(result?.level).toBe('pass')
    expect(frameworks.map((f) => f.result)).toEqual(['pass', 'pass'])
    expect(frameworks[0]?.support?.isEoas).toBe(true)
    expect(frameworks[0]?.target).toBeNull()
  })

  it('takes the worst entry as the level and lists them all', async () => {
    const { result, frameworks } = await run([
      dep('next', '15.5.29'),
      dep('@angular/core', '20.3.1'),
      dep('express', '5.1.0'),
    ])
    expect(result?.level).toBe('fail')
    expect(frameworks.map((f) => [f.packageName, f.result])).toEqual([
      ['@angular/core', 'fail'],
      ['express', 'pass'],
      ['next', 'warn'],
    ])
  })

  it('caps release cycle products at warn and says so', async () => {
    const { result, frameworks, evidence } = await run([dep('kestrelkit', '2.4.0')])
    expect(result?.level).toBe('warn')
    expect(frameworks[0]?.support).toMatchObject({ basis: 'release_cycle', isEol: true })
    expect(evidence && 'reason' in evidence && evidence.reason).toMatch(/release cycle/)
  })

  it('finds no framework in packages it does not know, or named like prototype keys', async () => {
    const { result, frameworks } = await run([
      dep('__proto__', '1.0.0'),
      dep('constructor', '1.0.0'),
      dep('prototype', '1.0.0'),
      dep('kestrel-ui', '1.0.0'),
    ])
    expect(frameworks).toEqual([])
    expect(result?.level).toBe('pass')
  })

  it('leaves findings alone without support data', async () => {
    const { result } = await run([dep('next', '14.2.35')], { support: null })
    expect(result).toBeUndefined()
  })

  it('leaves findings alone when the lockfiles were not read', async () => {
    const { result } = await run(null)
    expect(result).toBeUndefined()
  })

  it('opens a repo finding through the framework, and resolves it once upgraded', async () => {
    const log = { warn: () => {} }
    await runGuards(repos, [frameworkSupportGuard], ctxFor([dep('next', '14.2.35')]), log)
    const open = repos.findings.getByKey(`guard:framework_support:repo:${repo.id}`)
    expect(open).toMatchObject({ kind: 'guard', guardLevel: 'fail', state: 'open' })

    await runGuards(repos, [frameworkSupportGuard], ctxFor([dep('next', '16.4.5')]), log)
    expect(repos.findings.getByKey(`guard:framework_support:repo:${repo.id}`)?.state).toBe('fixed')
  })
})
