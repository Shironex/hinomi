import { FIX_RUN_STATES, isFixRunTerminal, type FixRunState } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  FIX_RUN_EVENT_SOURCES,
  FIX_RUN_REVIVALS,
  fixRunEventTarget,
  transitionFixRun,
  type FixRunEvent,
  type FixRunEventType,
  type FixRunTracked,
} from './fix-run-transitions.js'

const T0 = new Date('2026-11-07T08:00:00.000Z')
const T1 = new Date('2026-11-07T08:05:00.000Z')
const T2 = new Date('2026-11-07T08:10:00.000Z')

function run(state: FixRunState = 'pending', fields: Partial<FixRunTracked> = {}): FixRunTracked {
  return {
    state,
    stateReason: null,
    githubRunId: null,
    githubRunAttempt: null,
    headSha: null,
    prNumber: null,
    prUrl: null,
    prDraft: false,
    mergeSha: null,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    pushedAt: null,
    prOpenedAt: null,
    checksUpdatedAt: null,
    mergedAt: null,
    closedAt: null,
    deployedAt: null,
    rescannedAt: null,
    endedAt: null,
    stateChangedAt: T0,
    ...fields,
  }
}

const PR_OPENED = {
  type: 'pr_opened',
  number: 42,
  url: 'https://github.com/kestrel-co/storefront/pull/42',
  draft: false,
} as const satisfies FixRunEvent

/** One representative event of every type. */
const SAMPLES: Record<FixRunEventType, FixRunEvent> = {
  dispatch_accepted: { type: 'dispatch_accepted', githubRunId: 9001, githubRunAttempt: 1 },
  run_linked: { type: 'run_linked', githubRunId: 9001, githubRunAttempt: 1 },
  run_queued: { type: 'run_queued' },
  run_started: { type: 'run_started' },
  run_completed: { type: 'run_completed', conclusion: 'success', headSha: 'c0ffee1' },
  branch_pushed: { type: 'branch_pushed', headSha: 'c0ffee1' },
  pr_opened: PR_OPENED,
  pr_draft_changed: { type: 'pr_draft_changed', draft: true },
  checks_updated: { type: 'checks_updated', status: 'pending' },
  pr_merged: { type: 'pr_merged', mergeSha: 'feed123' },
  pr_closed: { type: 'pr_closed' },
  pr_reopened: { type: 'pr_reopened', number: 42 },
  deployment_seen: { type: 'deployment_seen' },
  rescan_result: { type: 'rescan_result', cleared: true, remaining: 0 },
  superseded: { type: 'superseded', byRunId: 7 },
  failed: { type: 'failed', reason: 'dispatch refused: workflow not found' },
  lost: { type: 'lost', reason: 'no update for 30 minutes' },
}
const EVENT_TYPES = Object.keys(SAMPLES) as FixRunEventType[]

function apply(start: FixRunTracked, ...events: FixRunEvent[]): FixRunTracked {
  return events.reduce((current, event) => {
    const next = transitionFixRun(current, event, T1)
    if (!next.ok) throw new Error(`${event.type}: ${next.rejection.message}`)
    return next.run
  }, start)
}

describe('transitionFixRun: allowed edges', () => {
  const edges = EVENT_TYPES.flatMap((type) =>
    FIX_RUN_EVENT_SOURCES[type].map((from) => [type, from] as const),
  )

  it.each(edges)('%s moves a %s run', (type, from) => {
    const event = SAMPLES[type]
    const to = fixRunEventTarget(event)
    // checks_updated lists every check state as a source; its own state is a plain repeat.
    const moves = to !== null && to !== from
    expect(transitionFixRun(run(from), event, T1)).toMatchObject({
      ok: true,
      changed: to !== from,
      run: { state: to ?? from, stateChangedAt: moves ? T1 : T0 },
    })
  })

  it('walks the happy path and stamps each step once', () => {
    const steps: [FixRunEvent, FixRunState, Date][] = [
      [SAMPLES.dispatch_accepted, 'dispatched', T0],
      [SAMPLES.run_queued, 'queued', T0],
      [{ type: 'run_started', githubRunId: 9001 }, 'running', T1],
      [SAMPLES.run_completed, 'branch_pushed', T1],
      [SAMPLES.pr_opened, 'pr_open', T1],
      [SAMPLES.checks_updated, 'checks_pending', T1],
      [{ type: 'checks_updated', status: 'passing', headSha: 'c0ffee1' }, 'checks_passing', T2],
      [SAMPLES.pr_merged, 'merged', T2],
      [SAMPLES.deployment_seen, 'deployed', T2],
      [SAMPLES.rescan_result, 'verified', T2],
    ]
    let current = run()
    for (const [event, state, at] of steps) {
      const next = transitionFixRun(current, event, at)
      expect(next).toMatchObject({ ok: true, changed: true, run: { state } })
      if (next.ok) current = next.run
    }
    expect(current).toMatchObject({
      githubRunId: 9001,
      githubRunAttempt: 1,
      headSha: 'c0ffee1',
      prNumber: 42,
      mergeSha: 'feed123',
      stateReason: null,
      dispatchedAt: T0,
      startedAt: T1,
      completedAt: T1,
      pushedAt: T1,
      prOpenedAt: T1,
      checksUpdatedAt: T2,
      mergedAt: T2,
      deployedAt: T2,
      rescannedAt: T2,
      endedAt: T2,
      closedAt: null,
    })
  })

  it('jumps forward over states polling missed', () => {
    expect(apply(run('dispatched'), SAMPLES.branch_pushed).state).toBe('branch_pushed')
    const opened = apply(run('pending'), SAMPLES.pr_opened)
    expect(opened).toMatchObject({ state: 'pr_open', prOpenedAt: T1, pushedAt: null })
    expect(apply(run('queued'), SAMPLES.run_completed).state).toBe('branch_pushed')
    expect(apply(run('checks_pending'), SAMPLES.pr_merged).state).toBe('merged')
    expect(apply(run('merged'), SAMPLES.rescan_result).state).toBe('verified')
  })

  it('moves between check results when checks run again', () => {
    const failing = apply(run('pr_open'), { type: 'checks_updated', status: 'failing' })
    expect(failing.state).toBe('checks_failing')
    const rerun = apply(failing, SAMPLES.checks_updated)
    expect(rerun.state).toBe('checks_pending')
    expect(apply(rerun, { type: 'checks_updated', status: 'passing' }).state).toBe('checks_passing')
    expect(apply(run('checks_passing'), { type: 'checks_updated', status: 'failing' }).state).toBe(
      'checks_failing',
    )
  })

  it('records a PR without checks, and leaves it when checks start', () => {
    const none = apply(run('pr_open'), { type: 'checks_updated', status: 'none' })
    expect(none).toMatchObject({ state: 'checks_none', checksUpdatedAt: T1 })
    expect(apply(none, SAMPLES.checks_updated).state).toBe('checks_pending')
    expect(apply(none, SAMPLES.pr_merged).state).toBe('merged')
  })

  it('maps run conclusions and rescan results to their states and reasons', () => {
    const cases: [FixRunEvent, FixRunState, string | null][] = [
      [{ type: 'run_completed', conclusion: 'failure' }, 'failed', 'run_failure'],
      [{ type: 'run_completed', conclusion: 'timed_out' }, 'failed', 'run_timed_out'],
      [{ type: 'run_completed', conclusion: 'cancelled' }, 'cancelled', 'run_cancelled'],
      [{ type: 'run_completed', conclusion: 'success', nothingToDo: true }, 'nothing_to_do', null],
      [SAMPLES.failed, 'failed', 'dispatch refused: workflow not found'],
      [SAMPLES.lost, 'lost', 'no update for 30 minutes'],
      [SAMPLES.superseded, 'superseded', 'superseded by run 7'],
    ]
    for (const [event, state, reason] of cases) {
      expect(apply(run('running'), event)).toMatchObject({ state, stateReason: reason })
    }
    const notCleared = apply(run('deployed'), {
      type: 'rescan_result',
      cleared: false,
      remaining: 3,
    })
    expect(notCleared).toMatchObject({
      state: 'not_cleared',
      stateReason: '3 findings still open',
      rescannedAt: T1,
      endedAt: T1,
    })
    expect(apply(run('nothing_to_do'), SAMPLES.rescan_result).state).toBe('verified')
  })

  it('keeps the PR as a draft or ready as the events say, and clears draft on merge', () => {
    const draft = apply(run('pr_open'), { ...PR_OPENED, draft: true })
    expect(draft.prDraft).toBe(true)
    const ready = apply(run('checks_failing', { prDraft: true }), {
      type: 'pr_draft_changed',
      draft: false,
    })
    expect(ready).toMatchObject({ state: 'checks_failing', prDraft: false })
    expect(apply(run('checks_failing', { prDraft: true }), SAMPLES.pr_merged).prDraft).toBe(false)
  })

  it('keeps the highest run attempt and fills the run id when learned late', () => {
    const linked = apply(run('queued'), SAMPLES.run_linked)
    expect(linked).toMatchObject({ state: 'queued', githubRunId: 9001, githubRunAttempt: 1 })
    const retried = apply(linked, { type: 'run_started', githubRunId: 9001, githubRunAttempt: 2 })
    expect(retried.githubRunAttempt).toBe(2)
    const older = apply(retried, { type: 'run_linked', githubRunId: 9001, githubRunAttempt: 1 })
    expect(older.githubRunAttempt).toBe(2)
  })
})

describe('transitionFixRun: rejections', () => {
  const matrix = FIX_RUN_STATES.flatMap((state) =>
    EVENT_TYPES.map((type) => [state, type] as const),
  )

  it.each(matrix)(
    'a %s run given %s is accepted only on a listed edge or a repeat',
    (from, type) => {
      const event = SAMPLES[type]
      const to = fixRunEventTarget(event)
      // The sample run tracks the sample PR, so the reopen sample revives a closed run. The re-run
      // samples carry no attempt and never revive a failed run (see the revival tests).
      const result = transitionFixRun(run(from, { prNumber: 42 }), event, T1)
      const listed = !isFixRunTerminal(from) && FIX_RUN_EVENT_SOURCES[type].includes(from)
      const revives = from === 'closed_unmerged' && type === 'pr_reopened'
      const rejections = isFixRunTerminal(from) ? ['terminal'] : ['stale', 'not_allowed']
      const allowed = listed || revives || to === from ? ['accepted'] : rejections
      expect(allowed).toContain(result.ok ? 'accepted' : result.rejection.code)
    },
  )

  it('calls an event for a state the run already left stale', () => {
    const cases: [FixRunState, FixRunEvent][] = [
      ['running', SAMPLES.run_queued],
      ['pr_open', SAMPLES.run_started],
      ['pr_open', SAMPLES.branch_pushed],
      ['checks_passing', SAMPLES.pr_opened],
      ['deployed', SAMPLES.pr_merged],
      ['merged', SAMPLES.checks_updated],
    ]
    for (const [from, event] of cases) {
      const result = transitionFixRun(run(from), event, T1)
      expect(result).toMatchObject({ ok: false, rejection: { code: 'stale' } })
    }
  })

  it('refuses events that make no sense from the current state', () => {
    const cases: [FixRunState, FixRunEvent][] = [
      ['running', SAMPLES.pr_merged],
      ['branch_pushed', SAMPLES.checks_updated],
      ['dispatched', SAMPLES.deployment_seen],
      ['pr_open', SAMPLES.rescan_result],
      ['running', SAMPLES.pr_draft_changed],
      ['merged', SAMPLES.superseded],
      ['pr_open', SAMPLES.failed],
      ['nothing_to_do', SAMPLES.branch_pushed],
    ]
    for (const [from, event] of cases) {
      const result = transitionFixRun(run(from), event, T1)
      expect(result).toMatchObject({ ok: false, rejection: { code: 'not_allowed' } })
    }
  })

  it('never moves a terminal run, but takes its own repeat quietly', () => {
    const closed = apply(run('pr_open'), SAMPLES.pr_closed)
    expect(closed).toMatchObject({ state: 'closed_unmerged', closedAt: T1, endedAt: T1 })
    expect(transitionFixRun(closed, SAMPLES.pr_merged, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'terminal' },
    })
    expect(transitionFixRun(closed, SAMPLES.pr_opened, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'terminal' },
    })
    const again = transitionFixRun(closed, SAMPLES.pr_closed, T2)
    expect(again).toEqual({ ok: true, run: closed, changed: false })

    const failed = apply(run('running'), SAMPLES.failed)
    const repeat = transitionFixRun(failed, { type: 'failed', reason: 'another reason' }, T2)
    expect(repeat).toEqual({ ok: true, run: failed, changed: false })
  })

  it('refuses a second PR or a different workflow run as a conflict', () => {
    const open = apply(run('branch_pushed'), SAMPLES.pr_opened)
    expect(transitionFixRun(open, { ...PR_OPENED, number: 43 }, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'conflict' },
    })
    const linked = apply(run('dispatched'), SAMPLES.run_linked)
    expect(transitionFixRun(linked, { type: 'run_started', githubRunId: 9002 }, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'conflict' },
    })
    expect(transitionFixRun(linked, { type: 'run_linked', githubRunId: 9002 }, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'conflict' },
    })
  })
})

describe('transitionFixRun: idempotency', () => {
  it.each(EVENT_TYPES)('repeating %s changes nothing the second time', (type) => {
    const event = SAMPLES[type]
    const from = FIX_RUN_EVENT_SOURCES[type][0] ?? 'closed_unmerged'
    const first = transitionFixRun(run(from, { prNumber: 42 }), event, T1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = transitionFixRun(first.run, event, T2)
    expect(second).toEqual({ ok: true, run: first.run, changed: false })
  })

  it('keeps the first timestamps when a repeat carries new fields', () => {
    const pushed = apply(run('running'), SAMPLES.run_completed)
    const moved = transitionFixRun(pushed, { type: 'branch_pushed', headSha: 'beef456' }, T2)
    expect(moved).toMatchObject({
      ok: true,
      changed: true,
      run: { state: 'branch_pushed', headSha: 'beef456', pushedAt: T1, stateChangedAt: T1 },
    })
  })

  it('fills the completion time when the run result arrives after the push was seen', () => {
    const pushed = apply(run('running'), SAMPLES.branch_pushed)
    expect(pushed.completedAt).toBeNull()
    const completed = transitionFixRun(pushed, SAMPLES.run_completed, T2)
    expect(completed).toMatchObject({
      ok: true,
      changed: true,
      run: { state: 'branch_pushed', completedAt: T2, pushedAt: T1 },
    })
  })
})

describe('transitionFixRun: revivals', () => {
  it('lists the only ways out of an ended state', () => {
    expect(FIX_RUN_REVIVALS).toEqual({
      closed_unmerged: ['pr_reopened'],
      failed: ['run_queued', 'run_started'],
      cancelled: ['run_queued', 'run_started'],
    })
  })

  it('reopens a closed PR and clears its end', () => {
    const closed = apply(run('checks_failing', { prNumber: 42, prOpenedAt: T0 }), SAMPLES.pr_closed)
    const reopened = transitionFixRun(closed, SAMPLES.pr_reopened, T2)
    expect(reopened).toMatchObject({
      ok: true,
      changed: true,
      run: {
        state: 'pr_open',
        stateReason: null,
        prOpenedAt: T0,
        closedAt: null,
        endedAt: null,
        stateChangedAt: T2,
      },
    })
    expect(transitionFixRun(closed, { type: 'pr_reopened', number: 43 }, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'conflict' },
    })
  })

  it('takes a failed workflow run back when the same run is re-run with a higher attempt', () => {
    const failed = apply(
      run('running', { githubRunId: 9001, githubRunAttempt: 1, startedAt: T0 }),
      { type: 'run_completed', conclusion: 'failure' },
    )
    expect(failed).toMatchObject({ state: 'failed', completedAt: T1, endedAt: T1 })

    const rerun = { type: 'run_started', githubRunId: 9001, githubRunAttempt: 2 } as const
    expect(transitionFixRun(failed, rerun, T2)).toMatchObject({
      ok: true,
      changed: true,
      run: {
        state: 'running',
        stateReason: null,
        githubRunAttempt: 2,
        startedAt: T2,
        completedAt: null,
        endedAt: null,
      },
    })
    expect(
      transitionFixRun(failed, { type: 'run_queued', githubRunId: 9001, githubRunAttempt: 2 }, T2),
    ).toMatchObject({ ok: true, run: { state: 'queued', startedAt: null } })
  })

  it('takes a cancelled workflow run back when the same run is re-run with a higher attempt', () => {
    const cancelled = apply(run('queued', { githubRunId: 9001, githubRunAttempt: 1 }), {
      type: 'run_completed',
      conclusion: 'cancelled',
    })
    expect(cancelled).toMatchObject({ state: 'cancelled', stateReason: 'run_cancelled' })

    const rerun = { type: 'run_queued', githubRunId: 9001, githubRunAttempt: 2 } as const
    expect(transitionFixRun(cancelled, rerun, T2)).toMatchObject({
      ok: true,
      changed: true,
      run: { state: 'queued', stateReason: null, githubRunAttempt: 2, endedAt: null },
    })
    const started = { type: 'run_started', githubRunId: 9001, githubRunAttempt: 2 } as const
    expect(transitionFixRun(cancelled, started, T2)).toMatchObject({
      ok: true,
      run: { state: 'running', startedAt: T2, completedAt: null },
    })
    for (const event of [
      { type: 'run_started', githubRunId: 9001, githubRunAttempt: 1 },
      { type: 'run_started', githubRunId: 9002, githubRunAttempt: 2 },
    ] as const) {
      expect(transitionFixRun(cancelled, event, T2)).toMatchObject({
        ok: false,
        rejection: { code: 'terminal' },
      })
    }
  })

  it('keeps a failed run ended for the same attempt, another run, or a run never linked', () => {
    const failed = run('failed', { githubRunId: 9001, githubRunAttempt: 2 })
    const cases: FixRunEvent[] = [
      { type: 'run_started', githubRunId: 9001, githubRunAttempt: 2 },
      { type: 'run_started', githubRunId: 9001 },
      { type: 'run_started', githubRunId: 9002, githubRunAttempt: 3 },
    ]
    for (const event of cases) {
      expect(transitionFixRun(failed, event, T2)).toMatchObject({
        ok: false,
        rejection: { code: 'terminal' },
      })
    }
    const neverLinked = run('failed', { stateReason: 'dispatch refused' })
    expect(
      transitionFixRun(
        neverLinked,
        { type: 'run_started', githubRunId: 9001, githubRunAttempt: 2 },
        T2,
      ),
    ).toMatchObject({ ok: false, rejection: { code: 'terminal' } })
    expect(transitionFixRun(run('cancelled'), SAMPLES.pr_reopened, T2)).toMatchObject({
      ok: false,
      rejection: { code: 'terminal' },
    })
  })
})
