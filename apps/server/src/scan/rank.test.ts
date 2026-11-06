import type { AdvisorySeverity, FindingScope } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { countFindings, isDeferred, isExposed, type CountableFinding } from './counts.js'
import {
  allStopped,
  compareByRank,
  isStoppedStatus,
  rankExposure,
  reachOf,
  type ExposureReach,
} from './rank.js'

const advisory = (
  severity: AdvisorySeverity,
  scope: FindingScope,
  reach: ExposureReach,
  cvssScore: number | null = null,
) => rankExposure({ kind: 'advisory', severity, scope, reach, cvssScore })

describe('rankExposure', () => {
  it.each([
    // severity, scope, reach, rank
    ['critical', 'runtime', 'public', 29],
    ['high', 'runtime', 'public', 28],
    ['moderate', 'runtime', 'public', 27],
    ['low', 'runtime', 'public', 26],
    ['critical', 'dev', 'public', 24],
    ['low', 'dev', 'public', 21],
    ['critical', 'runtime', 'internal', 19],
    ['critical', 'dev', 'internal', 14],
    ['critical', 'runtime', 'none', 9],
    ['low', 'dev', 'none', 1],
    ['unknown', 'runtime', 'public', 27],
    ['critical', 'unknown', 'public', 29],
  ] as const)('%s %s %s ranks %d', (severity, scope, reach, rank) => {
    expect(advisory(severity, scope, reach).rank).toBe(rank)
  })

  it('orders deployed public over internal over not deployed whatever the severity', () => {
    expect(advisory('low', 'runtime', 'public').rank).toBeGreaterThan(
      advisory('critical', 'runtime', 'internal').rank,
    )
    expect(advisory('low', 'dev', 'internal').rank).toBeGreaterThan(
      advisory('critical', 'runtime', 'none').rank,
    )
  })

  it('reports the four factors the UI explains the rank with', () => {
    expect(advisory('high', 'dev', 'internal').factors).toEqual({
      severity: 'high',
      runtime: false,
      deployed: true,
      public: false,
    })
    expect(advisory('critical', 'runtime', 'none').factors).toEqual({
      severity: 'critical',
      runtime: true,
      deployed: false,
      public: false,
    })
  })

  it('ranks an unknown severity as moderate and flags it unscored', () => {
    const unknown = advisory('unknown', 'runtime', 'public')
    expect(unknown.factors.severity).toBe('moderate')
    expect(unknown.unscored).toBe(true)
    expect(advisory('moderate', 'runtime', 'public').unscored).toBe(false)
  })

  it('treats an unknown scope as runtime, to be safe', () => {
    expect(advisory('high', 'unknown', 'public').factors.runtime).toBe(true)
  })

  it('breaks ties with the CVSS score without crossing a tier', () => {
    const a = advisory('high', 'runtime', 'public', 8.9)
    const b = advisory('high', 'runtime', 'public', 7.1)
    expect(a.rank).toBeGreaterThan(b.rank)
    expect(a.rank).toBeLessThan(advisory('critical', 'runtime', 'public').rank)
  })

  it('ranks alerts disabled on a deployed public repo like a critical', () => {
    const blind = rankExposure({
      kind: 'blind_spot',
      blindSpotType: 'alerts_disabled',
      scope: 'unknown',
      reach: 'public',
    })
    expect(blind.rank).toBe(advisory('critical', 'runtime', 'public').rank)
    expect(blind.factors).toEqual({
      severity: 'critical',
      runtime: true,
      deployed: true,
      public: true,
    })
  })

  it.each([
    ['alerts_unknown', 'high'],
    ['archived_deployed', 'high'],
    ['no_repo_mapping', 'moderate'],
    ['lockfile_missing', 'moderate'],
    ['lockfile_unparseable', 'moderate'],
  ] as const)('ranks blind spot %s like %s', (blindSpotType, severity) => {
    const rank = rankExposure({
      kind: 'blind_spot',
      blindSpotType,
      scope: 'unknown',
      reach: 'internal',
    })
    expect(rank.factors.severity).toBe(severity)
  })

  it('refuses a blind spot without a type', () => {
    expect(() => rankExposure({ kind: 'blind_spot', scope: 'unknown', reach: 'none' })).toThrow()
  })

  it('ranks a coverage note below every advisory, public before internal', () => {
    const note = (reach: ExposureReach) =>
      rankExposure({ kind: 'coverage_note', scope: 'unknown', reach })
    const lowest = advisory('low', 'dev', 'none')
    expect(note('public').rank).toBeLessThan(lowest.rank)
    expect(note('public').rank).toBeGreaterThan(note('internal').rank)
    expect(note('public').factors).toEqual({
      severity: 'low',
      runtime: true,
      deployed: true,
      public: true,
    })
  })

  it('sorts most urgent first', () => {
    const list = [advisory('low', 'dev', 'none'), advisory('critical', 'runtime', 'public')]
    expect(list.sort(compareByRank)[0]!.factors.severity).toBe('critical')
  })
})

describe('reachOf', () => {
  it('takes the widest reach and counts unknown as public', () => {
    expect(reachOf([])).toBe('none')
    expect(reachOf([{ reach: 'internal' }])).toBe('internal')
    expect(reachOf([{ reach: 'internal' }, { reach: 'public' }])).toBe('public')
    expect(reachOf([{ reach: 'unknown' }])).toBe('public')
  })
})

describe('stopped deployments', () => {
  it.each([
    ['exited:unhealthy', true],
    ['exited', true],
    ['stopped:unknown', true],
    ['Exited:unhealthy', true],
    ['running:healthy', false],
    ['running:unknown', false],
    ['restarting:unhealthy', false],
    ['degraded:unhealthy', false],
    ['unknown', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('classifies %s as stopped: %s', (status, stopped) => {
    expect(isStoppedStatus(status)).toBe(stopped)
  })

  it('ignores stopped deployments when taking the reach', () => {
    const live = { reach: 'internal' as const, status: 'running:healthy' }
    const down = { reach: 'public' as const, status: 'exited:unhealthy' }
    expect(reachOf([down])).toBe('none')
    expect(reachOf([down, live])).toBe('internal')
    expect(reachOf([{ reach: 'public', status: 'restarting:unhealthy' }])).toBe('public')
    expect(allStopped([down])).toBe(true)
    expect(allStopped([down, live])).toBe(false)
    expect(allStopped([])).toBe(false)
  })
})

describe('countFindings', () => {
  const now = new Date('2026-11-06T12:00:00Z')
  const later = new Date('2026-11-20T00:00:00Z')
  const earlier = new Date('2026-11-01T00:00:00Z')

  const item = (
    severity: AdvisorySeverity,
    scope: FindingScope,
    reach: ExposureReach,
    state: CountableFinding['state'] = 'open',
    stateUntil: Date | null = null,
  ): CountableFinding => ({
    kind: 'advisory',
    state,
    stateUntil,
    factors: advisory(severity, scope, reach).factors,
  })

  it('builds the funnel, exposed and needs action', () => {
    const counts = countFindings(
      [
        item('critical', 'runtime', 'public'),
        item('high', 'unknown', 'public', 'snoozed', later),
        item('critical', 'runtime', 'public', 'snoozed', earlier),
        item('critical', 'runtime', 'public', 'fixed'),
        item('critical', 'runtime', 'internal'),
        item('moderate', 'runtime', 'public'),
        item('critical', 'dev', 'public'),
        item('critical', 'runtime', 'none'),
      ],
      now,
    )
    expect(counts.advisories).toEqual({
      total: 7,
      deployed: 6,
      runtime: 5,
      criticalOrHigh: 4,
      public: 3,
      exposed: 3,
      needsAction: 2,
      dismissedUpstream: 0,
    })
  })

  it('lists a dismissed_upstream finding without exposing it or asking for action', () => {
    const counts = countFindings(
      [
        item('critical', 'runtime', 'public', 'dismissed_upstream'),
        item('critical', 'runtime', 'public'),
      ],
      now,
    )
    expect(counts.advisories).toMatchObject({
      total: 2,
      public: 2,
      exposed: 1,
      needsAction: 1,
      dismissedUpstream: 1,
    })
    expect(isExposed(item('critical', 'runtime', 'public', 'dismissed_upstream'))).toBe(false)
  })

  it('leaves coverage notes out of every count', () => {
    const counts = countFindings(
      [
        {
          kind: 'coverage_note',
          state: 'open',
          stateUntil: null,
          factors: rankExposure({ kind: 'coverage_note', scope: 'unknown', reach: 'public' })
            .factors,
        },
      ],
      now,
    )
    expect(counts.advisories.total).toBe(0)
    expect(counts.blindSpots.total).toBe(0)
  })

  it('counts blind spots separately', () => {
    const blind = (state: CountableFinding['state'], reach: ExposureReach): CountableFinding => ({
      kind: 'blind_spot',
      state,
      stateUntil: state === 'accepted' ? later : null,
      factors: rankExposure({
        kind: 'blind_spot',
        blindSpotType: 'alerts_disabled',
        scope: 'unknown',
        reach,
      }).factors,
    })
    const counts = countFindings(
      [blind('open', 'public'), blind('accepted', 'internal'), blind('fixed', 'public')],
      now,
    )
    expect(counts.blindSpots).toEqual({ total: 2, deployed: 2, public: 1, needsAction: 1 })
    expect(counts.advisories.total).toBe(0)
  })

  it('treats a snooze as in force until its expiry', () => {
    expect(isDeferred({ state: 'snoozed', stateUntil: later }, now)).toBe(true)
    expect(isDeferred({ state: 'snoozed', stateUntil: earlier }, now)).toBe(false)
    expect(isDeferred({ state: 'open', stateUntil: later }, now)).toBe(false)
  })
})
