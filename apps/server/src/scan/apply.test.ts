import type { OsvAdvisoryMatch } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { applyRepoAdvisories } from './apply.js'
import type { RepoScan } from './collect.js'
import { acceptFinding, FindingTransitionError, snoozeFinding } from './state.js'

// Every repo, package and advisory id here is fictional.

let repos: Repositories
let handle: DatabaseHandle
let repo: RepoRow

const t0 = new Date('2026-11-06T10:00:00Z')
const later = new Date('2026-11-08T10:00:00Z')

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor-web' })
})
afterEach(() => handle.close())

function match(osvId: string, pkg: string, extra: Partial<OsvAdvisoryMatch> = {}) {
  return {
    source: 'osv',
    osvId,
    ghsaId: null,
    cveIds: [],
    aliases: [],
    package: pkg,
    ecosystem: 'npm',
    severity: 'high',
    severityRaw: 'HIGH',
    cvss: null,
    summary: `Issue in ${pkg}`,
    description: `Long text about ${pkg}.`,
    vulnerableRange: '< 2.0.0',
    firstPatched: '2.0.0',
    publishedAt: null,
    modifiedAt: null,
    url: `https://osv.example.dev/${osvId}`,
    installedVersion: '1.0.0',
    scope: 'runtime',
    direct: false,
    ...extra,
  } satisfies OsvAdvisoryMatch
}

function osvScan(matches: OsvAdvisoryMatch[]): RepoScan {
  return {
    repo,
    deployed: true,
    health: { status: 'skipped', reason: 'test' },
    alerts: { status: 'skipped', reason: 'test' },
    osv: { status: 'ok', value: { matches, lockfiles: ['pnpm-lock.yaml'], unparseable: [] } },
  }
}

describe('applyRepoAdvisories', () => {
  it('stores the description, the lockfile and the dependency path of an OSV match', () => {
    applyRepoAdvisories(
      repos,
      osvScan([
        match('OSV-2026-1', 'plover-parse', {
          lockfile: 'apps/web/pnpm-lock.yaml',
          path: ['kestrel-http', 'plover-parse'],
        }),
      ]),
      t0,
    )
    const [finding] = repos.findings.list()
    expect(finding?.dependencyPath).toEqual(['kestrel-http', 'plover-parse'])
    expect(finding?.manifestPaths).toEqual(['apps/web/pnpm-lock.yaml'])
    expect(repos.advisories.get(finding!.advisoryId!)?.description).toBe(
      'Long text about plover-parse.',
    )
  })

  it('ends a snooze that waits for a new advisory when one appears for the same package', () => {
    applyRepoAdvisories(repos, osvScan([match('OSV-2026-1', 'plover-parse')]), t0)
    const [first] = repos.findings.list()
    const snoozed = snoozeFinding(repos.findings, first!.id, {
      reason: 'not reachable from our code',
      until: null,
      untilNewAdvisory: true,
      now: t0,
    })
    expect(snoozed).toMatchObject({
      state: 'snoozed',
      stateUntil: null,
      stateUntilNewAdvisory: true,
    })

    // The same advisory again, and a new one for another package: still snoozed.
    applyRepoAdvisories(
      repos,
      osvScan([match('OSV-2026-1', 'plover-parse'), match('OSV-2026-2', 'wren-dom')]),
      later,
    )
    expect(repos.findings.get(first!.id)?.state).toBe('snoozed')

    const changes = applyRepoAdvisories(
      repos,
      osvScan([
        match('OSV-2026-1', 'plover-parse'),
        match('OSV-2026-2', 'wren-dom'),
        match('OSV-2026-3', 'plover-parse'),
      ]),
      later,
    )
    const reopened = repos.findings.get(first!.id)
    expect(reopened).toMatchObject({ state: 'open', stateUntilNewAdvisory: false })
    expect(changes).toContainEqual({ findingId: first!.id, change: 'expired' })
    const [event] = repos.findings.listEvents(first!.id)
    expect(event).toMatchObject({ type: 'snooze_expired', actor: 'system' })
    expect(event?.data).toMatchObject({ reason: 'new_advisory' })
  })

  it('leaves dated snoozes and acceptances alone when a new advisory appears', () => {
    applyRepoAdvisories(repos, osvScan([match('OSV-2026-1', 'plover-parse')]), t0)
    const [first] = repos.findings.list()
    acceptFinding(repos.findings, first!.id, {
      reason: 'internal tool',
      until: new Date('2027-01-01T00:00:00Z'),
      now: t0,
    })
    applyRepoAdvisories(
      repos,
      osvScan([match('OSV-2026-1', 'plover-parse'), match('OSV-2026-3', 'plover-parse')]),
      later,
    )
    expect(repos.findings.get(first!.id)?.state).toBe('accepted')
  })

  it('refuses to wait for a new advisory on a blind spot', () => {
    const blind = repos.findings.observe(
      { kind: 'blind_spot', blindSpotType: 'alerts_disabled', repoId: repo.id },
      t0,
    ).finding
    expect(() =>
      snoozeFinding(repos.findings, blind.id, {
        reason: 'later',
        until: null,
        untilNewAdvisory: true,
        now: t0,
      }),
    ).toThrow(FindingTransitionError)
  })
})
