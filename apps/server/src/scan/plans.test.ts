import {
  fixPlanSchema,
  type FixPlan,
  type LockfileDependency,
  type OsvQuery,
  type OsvVulnerability,
} from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { parseLockfile, type OsvClient } from '../sources/osv/index.js'
import type { RepoScan } from './collect.js'
import { isFixable } from './fixes.js'
import { buildFixPlan, bumpLevel, saveScanPlans, type RepoLockfiles } from './plans.js'
import { listRankedFindings } from './views.js'

// Fictional repos of the kestrel-co org and made up packages only.

const T0 = new Date('2026-11-01T08:00:00.000Z')

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

interface FindingSpec {
  pkg: string
  key: string
  installed: string | null
  patched: string | null
  severity?: 'critical' | 'high' | 'moderate' | 'low'
  ecosystem?: string
  manifestPaths?: string[]
  path?: string[]
  ranges?: string[]
}

function addFinding(repo: RepoRow, spec: FindingSpec) {
  const advisory = repos.advisories.upsert({
    advisoryKey: `GHSA-${spec.key}`,
    ecosystem: spec.ecosystem ?? 'npm',
    packageName: spec.pkg,
    severity: spec.severity ?? 'high',
    firstPatchedVersion: spec.patched,
    ...(spec.ranges && { vulnerableRanges: spec.ranges }),
  })
  return repos.findings.observe(
    {
      kind: 'advisory',
      advisoryId: advisory.id,
      repoId: repo.id,
      scope: 'runtime',
      reportedBy: ['osv'],
      manifestPaths: spec.manifestPaths ?? [],
      ...(spec.installed !== null && { installedVersion: spec.installed }),
      ...(spec.path && { dependencyPath: spec.path }),
    },
    T0,
  ).finding
}

function lockfilesOf(files: Record<string, string>): RepoLockfiles {
  const dependencies: LockfileDependency[] = []
  for (const [path, text] of Object.entries(files)) {
    dependencies.push(...parseLockfile(text, path).map((d) => ({ ...d, lockfile: path })))
  }
  return { lockfiles: Object.keys(files), dependencies }
}

function planFor(repo: RepoRow, lockfiles: RepoLockfiles | null): FixPlan {
  const findings = listRankedFindings(repos)
    .filter(isFixable)
    .filter((f) => f.repo.id === repo.id)
  const plan = buildFixPlan({
    repo,
    scanRunId: 1,
    createdAt: T0,
    findings,
    lockfiles,
    previous: null,
  })
  // Every plan is a valid, serialisable contract.
  expect(fixPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
  return plan
}

const stepOf = (plan: FixPlan, pkg: string) => plan.steps.find((s) => s.packageName === pkg)!

const PNPM_MONOREPO = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      tern-test:
        specifier: ^1.0.0
        version: 1.4.0

  apps/web:
    dependencies:
      kestrel-http:
        specifier: ^2.1.0
        version: 2.1.0
      wren-dom:
        specifier: ^1.0.0
        version: 1.0.0

  packages/ui:
    dependencies:
      kestrel-http:
        specifier: ^2.1.0
        version: 2.1.0
      pad-ng:
        specifier: ^0.4.0
        version: 0.4.1

snapshots:

  kestrel-http@2.1.0:
    dependencies:
      plover-parse: 1.2.0

  pad-ng@0.4.1: {}

  plover-parse@1.2.0: {}

  tern-test@1.4.0: {}

  wren-dom@1.0.0: {}
`

describe('buildFixPlan with pnpm in a monorepo', () => {
  let plan: FixPlan
  beforeEach(() => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'storefront' })
    addFinding(repo, {
      pkg: 'kestrel-http',
      key: 'http-0001',
      installed: '2.1.0',
      patched: '2.1.2',
    })
    addFinding(repo, {
      pkg: 'kestrel-http',
      key: 'http-0002',
      installed: '2.1.0',
      patched: '2.1.3',
    })
    addFinding(repo, {
      pkg: 'plover-parse',
      key: 'plov-0001',
      installed: '1.2.0',
      patched: '1.2.5',
    })
    addFinding(repo, { pkg: 'wren-dom', key: 'wren-0001', installed: '1.0.0', patched: '2.0.0' })
    addFinding(repo, { pkg: 'pad-ng', key: 'pad-0001', installed: '0.4.1', patched: null })
    plan = planFor(repo, lockfilesOf({ 'pnpm-lock.yaml': PNPM_MONOREPO }))
  })

  it('detects the package manager and the workspace layout', () => {
    expect(plan.version).toBe(1)
    expect(plan.projects).toEqual([
      {
        lockfile: 'pnpm-lock.yaml',
        root: '.',
        packageManager: 'pnpm',
        workspaces: ['.', 'apps/web', 'packages/ui'],
      },
    ])
  })

  it('bumps a direct dependency once to the highest patch, in every workspace that lists it', () => {
    expect(stepOf(plan, 'kestrel-http')).toMatchObject({
      order: 1,
      relationship: 'direct',
      from: ['2.1.0'],
      to: '2.1.3',
      level: 'patch',
      risk: 'safe',
      note: null,
      workspaces: ['apps/web', 'packages/ui'],
      apply: {
        type: 'manifest_bump',
        manifests: ['apps/web/package.json', 'packages/ui/package.json'],
        packageName: 'kestrel-http',
        version: '2.1.3',
      },
      advisories: ['GHSA-http-0001', 'GHSA-http-0002'],
      releasedAt: null,
      releaseAge: 'unknown',
    })
    expect(stepOf(plan, 'kestrel-http').findingIds).toHaveLength(2)
  })

  it('fixes a transitive only package through pnpm.overrides in the root manifest', () => {
    expect(stepOf(plan, 'plover-parse')).toMatchObject({
      order: 2,
      relationship: 'transitive',
      via: ['kestrel-http'],
      workspaces: [],
      risk: 'safe',
      apply: {
        type: 'override',
        manifest: 'package.json',
        field: 'pnpm.overrides',
        key: 'plover-parse',
        value: '1.2.5',
      },
    })
  })

  it('puts a major last, flagged risky with the reason', () => {
    expect(stepOf(plan, 'wren-dom')).toMatchObject({
      order: 3,
      level: 'major',
      risk: 'risky',
      riskReasons: ['semver_major'],
      note: 'Semver major (1.0.0 to 2.0.0): read the changelog of wren-dom before merging.',
    })
  })

  it('lists an advisory with no patch as unfixed', () => {
    expect(plan.unfixed).toMatchObject([
      {
        packageName: 'pad-ng',
        installed: ['0.4.1'],
        blocker: 'no_patch',
        relationship: 'direct',
        workspaces: ['packages/ui'],
        availableAt: null,
      },
    ])
  })

  it('sums up what the plan clears by tier', () => {
    expect(plan.summary).toMatchObject({
      findings: { total: 5, cleared: 4, clearedSafely: 3, unfixed: 1 },
      steps: { safe: 2, risky: 1 },
      unfixed: 1,
    })
    expect(plan.summary.findings.clearedByTier.not_deployed).toBe(4)
    expect(plan.summary.findings.unfixedByTier.not_deployed).toBe(1)
  })
})

const PACKAGE_LOCK = JSON.stringify({
  name: 'ledger',
  lockfileVersion: 3,
  packages: {
    '': { name: 'ledger', dependencies: { 'kestrel-http': '^2.0.0', 'tern-old': '^1.0.0' } },
    'node_modules/kestrel-http': { version: '2.1.0', dependencies: { 'plover-parse': '^1.2.0' } },
    'node_modules/plover-parse': { version: '1.2.0' },
    'node_modules/tern-old': { version: '1.0.0', dependencies: { 'plover-parse': '^0.9.0' } },
    'node_modules/tern-old/node_modules/plover-parse': { version: '0.9.0' },
  },
})

describe('buildFixPlan with npm', () => {
  it('overrides a transitive package with npm overrides and flags other pinned versions', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger' })
    addFinding(repo, {
      pkg: 'plover-parse',
      key: 'plov-0002',
      installed: '1.2.0',
      patched: '1.2.5',
    })
    const plan = planFor(repo, lockfilesOf({ 'package-lock.json': PACKAGE_LOCK }))
    expect(plan.projects[0]).toMatchObject({ packageManager: 'npm', workspaces: ['.'] })
    expect(stepOf(plan, 'plover-parse')).toMatchObject({
      relationship: 'transitive',
      via: ['kestrel-http'],
      risk: 'risky',
      riskReasons: ['pins_other_versions'],
      apply: { type: 'override', manifest: 'package.json', field: 'overrides', value: '1.2.5' },
    })
  })
})

const YARN_LOCK = `__metadata:
  version: 8

"kestrel-http@npm:^2.0.0":
  version: 2.1.0
  resolution: "kestrel-http@npm:2.1.0"
  dependencies:
    plover-parse: "npm:^1.2.0"
  languageName: node
  linkType: hard

"docs@workspace:.":
  version: 0.0.0-use.local
  resolution: "docs@workspace:."
  dependencies:
    kestrel-http: "npm:^2.0.0"
  languageName: unknown
  linkType: soft

"plover-parse@npm:^1.2.0":
  version: 1.2.0
  resolution: "plover-parse@npm:1.2.0"
  languageName: node
  linkType: hard
`

describe('buildFixPlan with yarn', () => {
  it('overrides a transitive package through resolutions', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'docs' })
    addFinding(repo, {
      pkg: 'plover-parse',
      key: 'plov-0003',
      installed: '1.2.0',
      patched: '1.3.0',
    })
    const plan = planFor(repo, lockfilesOf({ 'yarn.lock': YARN_LOCK }))
    expect(stepOf(plan, 'plover-parse')).toMatchObject({
      level: 'minor',
      risk: 'safe',
      apply: { type: 'override', field: 'resolutions', key: 'plover-parse', value: '1.3.0' },
    })
  })
})

const BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "kiosk", "dependencies": {} },
    "apps/web": { "name": "web", "dependencies": { "@kestrel/ui": "^0.3.0" } },
  },
  "packages": {
    "@kestrel/ui": ["@kestrel/ui@0.3.0", "", {}, "sha512-AAAA"],
  }
}
`

describe('buildFixPlan with bun', () => {
  it('bumps a direct dependency in the workspace manifest that lists it', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'kiosk' })
    addFinding(repo, { pkg: '@kestrel/ui', key: 'ui-0001', installed: '0.3.0', patched: '0.3.4' })
    const plan = planFor(repo, lockfilesOf({ 'bun.lock': BUN_LOCK }))
    expect(plan.projects[0]?.packageManager).toBe('bun')
    expect(stepOf(plan, '@kestrel/ui')).toMatchObject({
      level: 'patch',
      risk: 'safe',
      apply: { type: 'manifest_bump', manifests: ['apps/web/package.json'], version: '0.3.4' },
    })
  })
})

const CARGO_LOCK = `version = 4

[[package]]
name = "edge-agent"
version = "0.1.0"
dependencies = [
 "kestrel-io",
]

[[package]]
name = "kestrel-io"
version = "2.1.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
 "plover",
]

[[package]]
name = "plover"
version = "0.9.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`

describe('buildFixPlan with Cargo', () => {
  it('updates a compatible crate in the lockfile and edits Cargo.toml for a major', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'edge' })
    const rust = { ecosystem: 'rust' }
    addFinding(repo, {
      pkg: 'plover',
      key: 'plo-0001',
      installed: '0.9.0',
      patched: '0.9.3',
      ...rust,
    })
    addFinding(repo, {
      pkg: 'kestrel-io',
      key: 'kio-0001',
      installed: '2.1.0',
      patched: '3.0.0',
      ...rust,
    })
    const plan = planFor(repo, lockfilesOf({ 'agent/Cargo.lock': CARGO_LOCK }))
    expect(plan.projects).toEqual([
      {
        lockfile: 'agent/Cargo.lock',
        root: 'agent',
        packageManager: 'cargo',
        workspaces: ['edge-agent'],
      },
    ])
    expect(plan.steps.map((s) => [s.order, s.packageName, s.risk])).toEqual([
      [1, 'plover', 'safe'],
      [2, 'kestrel-io', 'risky'],
    ])
    expect(stepOf(plan, 'plover').apply).toEqual({
      type: 'lockfile_update',
      tool: 'cargo',
      packageName: 'plover',
      from: ['0.9.0'],
      to: '0.9.3',
    })
    expect(stepOf(plan, 'kestrel-io')).toMatchObject({
      workspaces: ['edge-agent'],
      riskReasons: ['semver_major'],
      apply: { type: 'manifest_bump', manifests: [], packageName: 'kestrel-io', version: '3.0.0' },
    })
  })
})

describe('buildFixPlan without lockfile data', () => {
  it('falls back to the manifest and dependency path stored on the finding', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'billing' })
    addFinding(repo, {
      pkg: 'plover-parse',
      key: 'plov-0004',
      installed: '1.2.0',
      patched: '1.2.5',
      manifestPaths: ['apps/api/package-lock.json'],
      path: ['kestrel-http', 'plover-parse'],
    })
    addFinding(repo, {
      pkg: 'heron-py',
      key: 'her-0001',
      installed: null,
      patched: '4.0.1',
      ecosystem: 'pip',
      manifestPaths: ['requirements.txt'],
    })
    const plan = planFor(repo, null)
    expect(stepOf(plan, 'plover-parse')).toMatchObject({
      lockfile: 'apps/api/package-lock.json',
      relationship: 'transitive',
      risk: 'safe',
      apply: { type: 'override', manifest: 'apps/api/package.json', field: 'overrides' },
    })
    expect(stepOf(plan, 'heron-py')).toMatchObject({
      packageManager: 'unknown',
      relationship: 'unknown',
      risk: 'risky',
      riskReasons: ['unknown_version', 'unknown_relationship', 'unknown_package_manager'],
      apply: { type: 'manual' },
    })
    expect(plan.projects.map((p) => p.lockfile)).toEqual(['apps/api/package-lock.json'])
  })
})

describe('buildFixPlan with nothing to fix', () => {
  it('gives an empty plan that still lists the projects', () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'quiet' })
    const plan = planFor(repo, lockfilesOf({ 'package-lock.json': PACKAGE_LOCK }))
    expect(plan.steps).toEqual([])
    expect(plan.unfixed).toEqual([])
    expect(plan.summary).toMatchObject({
      findings: { total: 0, cleared: 0, clearedSafely: 0, unfixed: 0 },
      steps: { safe: 0, risky: 0 },
      unfixed: 0,
    })
    expect(plan.projects).toHaveLength(1)
  })
})

describe('bumpLevel', () => {
  it('reads semver levels, treating a 0.x minor as major', () => {
    expect(bumpLevel('1.2.3', '1.2.9')).toBe('patch')
    expect(bumpLevel('1.2.3', '1.4.0')).toBe('minor')
    expect(bumpLevel('1.2.3', '2.0.0')).toBe('major')
    expect(bumpLevel('0.3.1', '0.4.0')).toBe('major')
    expect(bumpLevel('0.3.1', '0.3.2')).toBe('patch')
    expect(bumpLevel('latest', '1.0.0')).toBe('unknown')
  })
})

function okScan(repo: RepoRow, lockfiles: RepoLockfiles): RepoScan {
  return {
    repo,
    deployed: false,
    health: { status: 'skipped', reason: 'GitHub is not connected' },
    alerts: { status: 'skipped', reason: 'GitHub is not connected' },
    osv: {
      status: 'ok',
      value: {
        matches: [],
        lockfiles: [...lockfiles.lockfiles],
        unparseable: [],
        dependencies: [...lockfiles.dependencies],
      },
    },
  }
}

describe('saveScanPlans', () => {
  it('stores a plan per scanned repo and says what the previous plan cleared', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger' })
    const quiet = repos.repos.upsert({ owner: 'kestrel-co', name: 'quiet' })
    const lockfiles = lockfilesOf({ 'package-lock.json': PACKAGE_LOCK })
    const http = addFinding(repo, {
      pkg: 'kestrel-http',
      key: 'http-0003',
      installed: '2.1.0',
      patched: '2.1.4',
    })
    const scans = new Map([
      [repo.id, okScan(repo, lockfiles)],
      [quiet.id, okScan(quiet, lockfiles)],
    ])
    const first = repos.scanRuns.start('manual', T0)
    const [plan] = await saveScanPlans(repos, first.id, scans, T0)
    expect(plan?.previous).toBeNull()
    expect(repos.fixPlans.forRepo(quiet.id)?.plan.steps).toEqual([])

    repos.findings.changeState(http.id, { state: 'fixed', actor: 'system' }, T0)
    const second = repos.scanRuns.start('schedule', T0)
    const [next] = await saveScanPlans(repos, second.id, scans, T0)
    expect(next?.previous).toEqual({ scanRunId: first.id, findings: 1, cleared: 1, stillOpen: 0 })
    expect(next?.steps).toEqual([])
    expect(repos.fixPlans.forRepo(repo.id, first.id)?.findingsCleared).toBe(1)
    expect(repos.fixPlans.forRepo(repo.id)?.scanRunId).toBe(second.id)
  })
})

/** An OSV stand in: vulnerabilities per `ecosystem:name@version`, and every batch it was asked. */
function fakeOsv(byVersion: Record<string, OsvVulnerability[]>, fail = false) {
  const batches: string[][] = []
  const vulns = new Map(Object.values(byVersion).flatMap((list) => list.map((v) => [v.id, v])))
  const keyOf = (q: OsvQuery) => `${q.package.ecosystem}:${q.package.name}@${q.version}`
  const client: OsvClient = {
    queryBatch: (queries) => {
      batches.push(queries.map(keyOf))
      if (fail) return Promise.reject(new Error('OSV answered 503'))
      return Promise.resolve(queries.map((q) => (byVersion[keyOf(q)] ?? []).map((v) => v.id)))
    },
    getVulnerability: (id) => Promise.resolve(vulns.get(id)!),
    getVulnerabilities: (ids) => Promise.resolve(ids.map((id) => vulns.get(id)!)),
    queryPackage: () => Promise.resolve([]),
  }
  return { client, batches }
}

const osvVuln = (
  id: string,
  ecosystem: string,
  name: string,
  events: { introduced?: string; fixed?: string }[],
): OsvVulnerability => ({
  id,
  affected: [{ package: { name, ecosystem }, ranges: [{ type: 'SEMVER', events }] }],
})

const LODASH_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.20
        version: 4.17.20

snapshots:

  lodash@4.17.20: {}
`

describe('saveScanPlans target check', () => {
  async function planWith(repo: RepoRow, lockfiles: RepoLockfiles, osv: OsvClient | null) {
    const warnings: string[] = []
    const run = repos.scanRuns.start('manual', T0)
    const plans = await saveScanPlans(
      repos,
      run.id,
      new Map([[repo.id, okScan(repo, lockfiles)]]),
      T0,
      {
        osv,
        warn: (message) => warnings.push(message),
      },
    )
    const plan = plans[0]!
    expect(fixPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
    return { plan, warnings }
  }

  it('skips a target OSV knows is vulnerable: lodash goes to 4.18.1, not 4.18.0', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'throwaway' })
    const lodash = { pkg: 'lodash', installed: '4.17.20' }
    addFinding(repo, { ...lodash, key: 'lo-0001', patched: '4.17.21', ranges: ['< 4.17.21'] })
    addFinding(repo, { ...lodash, key: 'lo-0002', patched: '4.17.23', ranges: ['< 4.17.23'] })
    addFinding(repo, { ...lodash, key: 'lo-0003', patched: '4.18.0', ranges: ['< 4.18.0'] })
    addFinding(repo, {
      ...lodash,
      key: 'lo-0004',
      patched: '4.18.0',
      ranges: ['>= 4.0.0, < 4.18.0'],
    })
    const osv = fakeOsv({
      'npm:lodash@4.18.0': [
        {
          ...osvVuln('GHSA-f23m-r3pf-42rh', 'npm', 'lodash', [
            { introduced: '4.18.0' },
            { fixed: '4.18.1' },
          ]),
          aliases: ['CVE-2026-2950'],
        },
      ],
    })
    const { plan, warnings } = await planWith(
      repo,
      lockfilesOf({ 'pnpm-lock.yaml': LODASH_LOCK }),
      osv.client,
    )
    expect(osv.batches).toEqual([['npm:lodash@4.18.0'], ['npm:lodash@4.18.1']])
    expect(stepOf(plan, 'lodash')).toMatchObject({
      from: ['4.17.20'],
      to: '4.18.1',
      level: 'minor',
      risk: 'safe',
      note: null,
      apply: { type: 'manifest_bump', manifests: ['package.json'], version: '4.18.1' },
      targetCheck: {
        status: 'clean',
        minimum: '4.18.0',
        avoids: ['GHSA-f23m-r3pf-42rh'],
        stillAffected: [],
      },
    })
    expect(warnings).toEqual([])
  })

  it('keeps the step and says so when no clean version is known in its semver line', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'storefront' })
    addFinding(repo, {
      pkg: 'kestrel-http',
      key: 'http-0001',
      installed: '2.1.0',
      patched: '2.1.2',
    })
    const osv = fakeOsv({
      'npm:kestrel-http@2.1.2': [
        osvVuln('GHSA-http-0009', 'npm', 'kestrel-http', [
          { introduced: '2.0.0' },
          { fixed: '3.0.0' },
        ]),
      ],
    })
    const { plan } = await planWith(
      repo,
      lockfilesOf({ 'pnpm-lock.yaml': PNPM_MONOREPO }),
      osv.client,
    )
    const step = stepOf(plan, 'kestrel-http')
    expect(step).toMatchObject({
      to: '2.1.2',
      risk: 'safe',
      targetCheck: { status: 'affected', avoids: [], stillAffected: ['GHSA-http-0009'] },
    })
    expect(step.note).toContain('The next fix it knows, 3.0.0, is a semver major.')
    expect(osv.batches).toEqual([['npm:kestrel-http@2.1.2']])
  })

  it('keeps the current target with a note when OSV cannot answer', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'storefront' })
    addFinding(repo, {
      pkg: 'kestrel-http',
      key: 'http-0001',
      installed: '2.1.0',
      patched: '2.1.2',
    })
    const osv = fakeOsv({}, true)
    const { plan, warnings } = await planWith(
      repo,
      lockfilesOf({ 'pnpm-lock.yaml': PNPM_MONOREPO }),
      osv.client,
    )
    expect(stepOf(plan, 'kestrel-http')).toMatchObject({
      to: '2.1.2',
      targetCheck: { status: 'unchecked', avoids: [], stillAffected: [] },
      note: 'Hinomi could not check kestrel-http 2.1.2 against OSV, so an advisory of that version may be missing.',
    })
    expect(osv.batches).toHaveLength(1)
    expect(warnings).toEqual(['scan: OSV could not check fix targets'])
  })

  it('checks crates with the crates.io ecosystem and moves the cargo update target', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'edge' })
    addFinding(repo, {
      pkg: 'plover',
      key: 'plo-0001',
      installed: '0.9.0',
      patched: '0.9.3',
      ecosystem: 'rust',
    })
    // Stored from another repo: 0.9.3 is affected, fixed in 0.9.5.
    repos.advisories.upsert({
      advisoryKey: 'GHSA-plo-0002',
      ecosystem: 'rust',
      packageName: 'plover',
      vulnerableRanges: ['>= 0.9.3, < 0.9.5'],
      firstPatchedVersion: '0.9.5',
    })
    const osv = fakeOsv({})
    const { plan } = await planWith(
      repo,
      lockfilesOf({ 'agent/Cargo.lock': CARGO_LOCK }),
      osv.client,
    )
    expect(osv.batches).toEqual([['crates.io:plover@0.9.5']])
    expect(stepOf(plan, 'plover')).toMatchObject({
      to: '0.9.5',
      apply: { type: 'lockfile_update', tool: 'cargo', from: ['0.9.0'], to: '0.9.5' },
      targetCheck: { status: 'clean', minimum: '0.9.3', avoids: ['GHSA-plo-0002'] },
    })
  })

  it('asks OSV once per version for every repo of the scan', async () => {
    const a = repos.repos.upsert({ owner: 'kestrel-co', name: 'storefront' })
    const b = repos.repos.upsert({ owner: 'kestrel-co', name: 'ledger' })
    const lockfiles = lockfilesOf({ 'pnpm-lock.yaml': PNPM_MONOREPO })
    for (const repo of [a, b]) {
      addFinding(repo, {
        pkg: 'kestrel-http',
        key: 'http-0001',
        installed: '2.1.0',
        patched: '2.1.2',
      })
    }
    const osv = fakeOsv({})
    const run = repos.scanRuns.start('manual', T0)
    const scans = new Map([
      [a.id, okScan(a, lockfiles)],
      [b.id, okScan(b, lockfiles)],
    ])
    const plans = await saveScanPlans(repos, run.id, scans, T0, { osv: osv.client })
    expect(osv.batches).toEqual([['npm:kestrel-http@2.1.2']])
    expect(plans.map((p) => stepOf(p, 'kestrel-http').targetCheck?.status)).toEqual([
      'clean',
      'clean',
    ])
  })
})
