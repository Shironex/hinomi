import type { RepoHealth } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { RepoScan } from '../collect.js'
import type { SourceProbe } from '../ownership.js'
import { indexOverrides } from '../overrides.js'
import { evaluateArchivedDeployed } from './archived-deployed.js'
import { context, deployment, reasonOf, repo, resultFor } from './network-fixtures.js'
import type { GuardContext, GuardSubjectResult } from './types.js'

// Fictional kestrel-co repos; the health is what the alerts phase read from GitHub.

const harbor = repo(1, 'harbor')
const ledger = repo(2, 'ledger')

function health(row: RepoRow, over: Partial<RepoHealth> = {}): RepoScan['health'] {
  return {
    status: 'ok',
    value: {
      owner: row.owner,
      name: row.name,
      archived: false,
      defaultBranch: 'main',
      visibility: 'private',
      alertsEnabled: true,
      pushedAt: '2026-03-02T09:00:00Z',
      ...over,
    },
  }
}

const probe = (
  sourceId: number,
  sees: boolean | null,
  errorKind?: SourceProbe['errorKind'],
): SourceProbe => ({
  sourceId,
  sees,
  alertsReadable: null,
  ...(errorKind && { error: `GitHub said ${errorKind}`, errorKind }),
})

/** A repo override on `repoId` turning the check off, as the override table stores it. */
function repoOverride(repoId: number, id = repoId) {
  const at = new Date('2026-11-01T00:00:00Z')
  return {
    id,
    check: 'archived_deployed' as const,
    deploymentId: null,
    repoId,
    reason: 'frozen on purpose',
    createdAt: at,
    updatedAt: at,
  }
}

/** A context whose repos answered with `answers` (health, plus the probes when given). */
function contextWith(
  deployments: DeploymentRow[],
  answers: Map<RepoRow, { health: RepoScan['health']; probes?: SourceProbe[] }>,
): GuardContext {
  const ctx = context(deployments, [...answers.keys()])
  const scans = new Map(ctx.scans)
  for (const [row, answer] of answers) scans.set(row.id, { ...scans.get(row.id)!, ...answer })
  return { ...ctx, scans }
}

function run(answer: { health: RepoScan['health']; probes?: SourceProbe[] }) {
  const row = deployment(1, 'harbor-api', { repoId: harbor.id })
  return resultFor(
    evaluateArchivedDeployed(contextWith([row], new Map([[harbor, answer]]))),
    row.id,
  )
}

const evidenceOf = (result: GuardSubjectResult) =>
  result.level !== null && result.evidence?.check === 'archived_deployed' ? result.evidence : null

describe('archived_deployed', () => {
  it('fails a deployment that runs an archived repo', () => {
    const result = run({ health: health(harbor, { archived: true }) })
    expect(result.level).toBe('fail')
    expect(evidenceOf(result)).toEqual({
      check: 'archived_deployed',
      repos: [
        {
          repoId: 1,
          repo: 'kestrel-co/harbor',
          renamedTo: null,
          archived: true,
          pushedAt: '2026-03-02T09:00:00Z',
          result: 'fail',
          reason: null,
          turnedOff: false,
        },
      ],
      reason: null,
    })
  })

  it('passes when the repo is not archived (or was unarchived)', () => {
    const result = run({ health: health(harbor) })
    expect(result.level).toBe('pass')
    expect(evidenceOf(result)?.repos).toMatchObject([{ archived: false, result: 'pass' }])
  })

  it('follows a renamed repo and judges it under its new name', () => {
    const renamed = run({ health: health(harbor, { name: 'harbor-legacy', archived: true }) })
    expect(renamed.level).toBe('fail')
    expect(evidenceOf(renamed)?.repos[0]).toMatchObject({
      repo: 'kestrel-co/harbor',
      renamedTo: 'kestrel-co/harbor-legacy',
    })

    const moved = run({ health: health(harbor, { owner: 'Kestrel-Archive' }) })
    expect(moved.level).toBe('pass')
    expect(evidenceOf(moved)?.repos[0]?.renamedTo).toBe('Kestrel-Archive/harbor')
  })

  it('does not call a change of letter case a rename', () => {
    const result = run({ health: health(harbor, { owner: 'Kestrel-Co', name: 'Harbor' }) })
    expect(evidenceOf(result)?.repos[0]?.renamedTo).toBeNull()
  })

  it('is unknown when every GitHub source says the repo is not found', () => {
    const result = run({
      health: { status: 'error', error: 'GitHub resource not found' },
      probes: [probe(1, false), probe(2, false)],
    })
    expect(result.level).toBe('unknown')
    expect(reasonOf(result)).toContain('No connected GitHub source sees this repo')
    expect(evidenceOf(result)?.repos).toMatchObject([{ archived: null, result: 'unknown' }])
  })

  it('is unknown when no source lists the repo or GitHub is not connected', () => {
    const unlisted = run({
      health: { status: 'skipped', reason: 'no GitHub source sees this repo' },
    })
    expect(unlisted.level).toBe('unknown')
    expect(reasonOf(unlisted)).toContain('No connected GitHub source')

    const offline = run({ health: { status: 'skipped', reason: 'GitHub is not connected' } })
    expect(offline.level).toBe('unknown')
    expect(reasonOf(offline)).toContain('GitHub is not connected')
  })

  it('is unknown when the token or app lost access (sign in or permission refused)', () => {
    for (const kind of ['auth', 'permission'] as const) {
      const result = run({
        health: { status: 'error', error: 'refused' },
        probes: [probe(1, null, kind), probe(2, false)],
      })
      expect(result.level).toBe('unknown')
      expect(reasonOf(result)).toContain('lost access')
    }
  })

  it('leaves the row alone when one source lost access and another hit a rate limit', () => {
    const result = run({
      health: { status: 'error', error: 'rate limit' },
      probes: [probe(1, null, 'permission'), probe(2, null, 'rate_limit')],
    })
    expect(result.level).toBeNull()
    const server = run({
      health: { status: 'error', error: 'bad gateway' },
      probes: [probe(1, null, 'http')],
    })
    expect(server.level).toBeNull()
  })

  it('leaves the row alone when GitHub failed for a passing reason', () => {
    const rateLimited = run({
      health: { status: 'error', error: 'GitHub rate limit reached' },
      probes: [probe(1, null), probe(2, false)],
    })
    expect(rateLimited.level).toBeNull()
    // A hand built scan with no probes cannot tell a missing repo from a failure.
    expect(run({ health: { status: 'error', error: 'network down' } }).level).toBeNull()
  })

  it('passes a deployment that runs no repo, so a stale finding closes', () => {
    const image = deployment(3, 'image-proxy', { repoId: null })
    const result = resultFor(evaluateArchivedDeployed(context([image])), image.id)
    expect(result.level).toBe('pass')
    expect(evidenceOf(result)).toMatchObject({ repos: [] })
    expect(reasonOf(result)).toContain('no mapped repo')
  })

  it('judges every repo a deployment runs, the worst one wins', () => {
    const monorepo = deployment(4, 'kestrel-suite', { repoId: harbor.id })
    const ctx = contextWith(
      [monorepo],
      new Map([
        [harbor, { health: health(harbor) }],
        [ledger, { health: health(ledger, { archived: true }) }],
      ]),
    )
    ctx.index.byRepo.set(ledger.id, [monorepo])
    const result = resultFor(evaluateArchivedDeployed(ctx), monorepo.id)
    expect(result.level).toBe('fail')
    expect(evidenceOf(result)?.repos.map((r) => [r.repo, r.result])).toEqual([
      ['kestrel-co/harbor', 'pass'],
      ['kestrel-co/ledger', 'fail'],
    ])
  })

  it('fails on an archived repo even when another repo of the deployment could not be read', () => {
    const monorepo = deployment(5, 'kestrel-suite', { repoId: harbor.id })
    const ctx = contextWith(
      [monorepo],
      new Map([
        [harbor, { health: { status: 'error', error: 'timeout' } }],
        [ledger, { health: health(ledger, { archived: true }) }],
      ]),
    )
    ctx.index.byRepo.set(ledger.id, [monorepo])
    expect(resultFor(evaluateArchivedDeployed(ctx), monorepo.id).level).toBe('fail')

    const unarchived = contextWith(
      [monorepo],
      new Map([
        [harbor, { health: { status: 'error', error: 'timeout' } }],
        [ledger, { health: health(ledger) }],
      ]),
    )
    unarchived.index.byRepo.set(ledger.id, [monorepo])
    expect(resultFor(evaluateArchivedDeployed(unarchived), monorepo.id).level).toBeNull()
  })

  describe('with a repo override on one repo of a deployment', () => {
    const suite = deployment(7, 'kestrel-suite', { repoId: harbor.id })
    function suiteResult(harborArchived: boolean, ledgerArchived: boolean, off: number[]) {
      const ctx = contextWith(
        [suite],
        new Map([
          [harbor, { health: health(harbor, { archived: harborArchived }) }],
          [ledger, { health: health(ledger, { archived: ledgerArchived }) }],
        ]),
      )
      ctx.index.byRepo.set(ledger.id, [suite])
      const overrides = indexOverrides(
        off.map((id) => repoOverride(id)),
        ctx.index,
      )
      return resultFor(evaluateArchivedDeployed({ ...ctx, overrides }), suite.id)
    }

    it('still fails on another repo that is archived, and marks the turned off one', () => {
      const result = suiteResult(false, true, [harbor.id])
      expect(result.level).toBe('fail')
      expect(evidenceOf(result)?.repos.map((r) => [r.repo, r.result, r.turnedOff])).toEqual([
        ['kestrel-co/harbor', 'pass', true],
        ['kestrel-co/ledger', 'fail', false],
      ])
    })

    it('passes when only the turned off repo is archived', () => {
      expect(suiteResult(true, false, [harbor.id]).level).toBe('pass')
    })

    it('keeps the level of the repos when every one is turned off', () => {
      expect(suiteResult(true, false, [harbor.id, ledger.id]).level).toBe('fail')
    })

    it('covers the deployment only when every repo it runs has the override', () => {
      const ctx = context([suite], [harbor, ledger])
      ctx.index.byRepo.set(ledger.id, [suite])
      const one = indexOverrides([repoOverride(harbor.id)], ctx.index)
      expect(one.covering('archived_deployed', { deploymentId: suite.id })).toBeNull()
      // Other checks keep their rule: an override on any repo it runs covers it.
      expect(
        indexOverrides(
          [{ ...repoOverride(harbor.id), check: 'root_user' as const }],
          ctx.index,
        ).covering('root_user', { deploymentId: suite.id }),
      ).not.toBeNull()
      const both = indexOverrides([repoOverride(harbor.id), repoOverride(ledger.id)], ctx.index)
      expect(both.covering('archived_deployed', { deploymentId: suite.id })).toMatchObject({
        scope: 'repo',
      })
    })
  })

  it('checks stopped deployments too', () => {
    const row = deployment(6, 'harbor-old', { repoId: harbor.id, status: 'exited' })
    const ctx = contextWith(
      [row],
      new Map([[harbor, { health: health(harbor, { archived: true }) }]]),
    )
    expect(resultFor(evaluateArchivedDeployed(ctx), row.id).level).toBe('fail')
  })
})
