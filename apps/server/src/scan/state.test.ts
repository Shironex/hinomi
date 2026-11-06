import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import {
  acceptFinding,
  canUserTransition,
  expireDeferred,
  FindingTransitionError,
  markFixed,
  reopenFinding,
  reopenIfFixed,
  snoozeFinding,
} from './state.js'

let repos: Repositories
let handle: DatabaseHandle

const t0 = new Date('2026-11-06T10:00:00Z')
const day = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(t0.getTime() + days * day)

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

function seedFinding() {
  const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor-web' })
  const advisory = repos.advisories.upsert({
    advisoryKey: 'GHSA-0000-1111-2222',
    ghsaId: 'GHSA-0000-1111-2222',
    ecosystem: 'npm',
    packageName: 'example-lib',
    severity: 'high',
  })
  return repos.findings.observe(
    { kind: 'advisory', advisoryId: advisory.id, repoId: repo.id, reportedBy: ['github'] },
    t0,
  ).finding
}

const eventTypes = (id: number) =>
  repos.findings
    .listEvents(id)
    .map((e) => `${e.type}:${e.fromState ?? '-'}>${e.toState}:${e.actor}`)
    .reverse()

describe('finding state machine', () => {
  it('snoozes with a reason and expiry, and reopens on its own once it passes', () => {
    const finding = seedFinding()
    const snoozed = snoozeFinding(repos.findings, finding.id, {
      reason: 'waiting for upstream',
      until: at(7),
      now: t0,
    })
    expect(snoozed).toMatchObject({ state: 'snoozed', stateReason: 'waiting for upstream' })
    expect(snoozed.stateUntil).toEqual(at(7))

    expect(expireDeferred(repos.findings, at(6))).toHaveLength(0)
    const reopened = expireDeferred(repos.findings, at(7))
    expect(reopened.map((f) => f.state)).toEqual(['open'])
    expect(repos.findings.get(finding.id)).toMatchObject({ state: 'open', stateReason: null })
    expect(eventTypes(finding.id)).toEqual([
      'opened:->open:system',
      'snoozed:open>snoozed:user',
      'snooze_expired:snoozed>open:system',
    ])
  })

  it('accepts with a reason and expiry, and expires the same way', () => {
    const finding = seedFinding()
    acceptFinding(repos.findings, finding.id, {
      reason: 'not reachable in our setup',
      until: at(30),
      now: t0,
    })
    expect(repos.findings.get(finding.id)?.state).toBe('accepted')
    expireDeferred(repos.findings, at(31))
    expect(eventTypes(finding.id).at(-1)).toBe('acceptance_expired:accepted>open:system')
  })

  it('refuses a missing reason or an expiry in the past', () => {
    const finding = seedFinding()
    expect(() =>
      snoozeFinding(repos.findings, finding.id, { reason: '  ', until: at(1), now: t0 }),
    ).toThrow(FindingTransitionError)
    expect(() =>
      acceptFinding(repos.findings, finding.id, { reason: 'ok', until: at(-1), now: t0 }),
    ).toThrow(FindingTransitionError)
    expect(repos.findings.listEvents(finding.id)).toHaveLength(1)
  })

  it('lets the user cancel a snooze', () => {
    const finding = seedFinding()
    snoozeFinding(repos.findings, finding.id, { reason: 'later', until: at(3), now: t0 })
    reopenFinding(repos.findings, finding.id, { now: at(1) })
    expect(eventTypes(finding.id).at(-1)).toBe('reopened:snoozed>open:user')
  })

  it('marks fixed by scan and reopens when the advisory reappears', () => {
    const finding = seedFinding()
    snoozeFinding(repos.findings, finding.id, { reason: 'later', until: at(3), now: t0 })
    const fixed = markFixed(repos.findings, repos.findings.get(finding.id)!, at(1))
    expect(fixed).toMatchObject({ state: 'fixed' })
    expect(fixed?.fixedAt).toEqual(at(1))
    expect(markFixed(repos.findings, fixed!, at(2))).toBeNull()

    const reopened = reopenIfFixed(repos.findings, fixed!, at(2))
    expect(reopened).toMatchObject({ state: 'open', fixedAt: null })
    expect(reopenIfFixed(repos.findings, reopened!, at(3))).toBeNull()
    expect(eventTypes(finding.id).slice(-2)).toEqual([
      'fixed:snoozed>fixed:system',
      'reopened:fixed>open:system',
    ])
  })

  it('does not let a user move a fixed finding', () => {
    const finding = seedFinding()
    markFixed(repos.findings, finding, at(1))
    expect(() =>
      snoozeFinding(repos.findings, finding.id, { reason: 'x', until: at(5), now: at(2) }),
    ).toThrow(/fixed finding cannot be moved/)
    expect(() => reopenFinding(repos.findings, finding.id)).toThrow(FindingTransitionError)
  })

  it('knows the user transitions', () => {
    expect(canUserTransition('open', 'snoozed')).toBe(true)
    expect(canUserTransition('open', 'open')).toBe(false)
    expect(canUserTransition('snoozed', 'accepted')).toBe(true)
    expect(canUserTransition('fixed', 'open')).toBe(false)
    expect(canUserTransition('open', 'fixed')).toBe(false)
  })
})
