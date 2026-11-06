import { describe, expect, it, vi } from 'vitest'
import { controllableScan, EMPTY_SOURCES, recordingLogger } from '../api/testing.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import {
  createScheduler,
  INTERRUPTED_SCAN_MESSAGE,
  SCAN_INTERVAL_KEY,
  SchedulerClosedError,
  type SchedulerOptions,
} from './scheduler.js'

const HOUR = 3_600_000

/** A clock and a single timer slot the test drives by hand. */
function manualTimers(start = new Date('2026-11-01T10:00:00Z')) {
  let now = start.getTime()
  let pending: { fn: () => void; at: number } | null = null
  return {
    now: () => new Date(now),
    setTimer: (fn: () => void, ms: number) => {
      pending = { fn, at: now + ms }
      return pending
    },
    clearTimer: (handle: unknown) => {
      if (handle === pending) pending = null
    },
    /** Moves the clock to the pending timer and fires it. */
    fire() {
      const timer = pending
      if (!timer) throw new Error('no timer pending')
      pending = null
      now = Math.max(now, timer.at)
      timer.fn()
    },
    pendingAt: () => (pending ? new Date(pending.at) : null),
    advance(ms: number) {
      now += ms
    },
  }
}

function connect(repos: Repositories) {
  repos.sources.create({ kind: 'github', name: 'kestrel', token: 'fictional-token-0001' })
}

function setup(overrides: Partial<SchedulerOptions> = {}) {
  const { repos } = createTestRepositories()
  const scan = controllableScan()
  const timers = manualTimers()
  const logger = recordingLogger()
  const scheduler = createScheduler({
    repositories: repos,
    log: logger.log,
    now: timers.now,
    buildSources: () => EMPTY_SOURCES,
    runScan: scan.runScan,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  })
  return { repos, scan, timers, logger, scheduler }
}

describe('scheduler', () => {
  it('marks a scan left running by a crash as failed on start', () => {
    const { repos, scheduler } = setup()
    const stale = repos.scanRuns.start('schedule', new Date('2026-11-01T09:00:00Z'))
    scheduler.start()
    const run = repos.scanRuns.get(stale.id)!
    expect(run.status).toBe('failed')
    expect(run.error).toBe(INTERRUPTED_SCAN_MESSAGE)
    expect(run.finishedAt).not.toBeNull()
    expect(repos.scanRuns.running()).toBeUndefined()
  })

  it('scans at once on first boot when a source is connected, then every interval', async () => {
    const { repos, scan, timers, scheduler } = setup()
    connect(repos)
    scheduler.start()
    expect(timers.pendingAt()).toEqual(timers.now())
    timers.fire()
    expect(scan.calls.map((c) => c.trigger)).toEqual(['boot'])
    expect(scheduler.nextScanAt()).toBeNull()

    scan.finish()
    await scheduler.idle()
    // The next scan is one interval (6 h by default) after the last one started.
    expect(timers.pendingAt()?.getTime()).toBe(timers.now().getTime() + 6 * HOUR)
    expect(scheduler.nextScanAt()).toEqual(timers.pendingAt())
    timers.fire()
    expect(scan.calls.map((c) => c.trigger)).toEqual(['boot', 'schedule'])
  })

  it('honours the interval setting and replans when it changes', () => {
    const { repos, timers, scheduler } = setup()
    connect(repos)
    repos.settings.set(SCAN_INTERVAL_KEY, 60)
    const last = repos.scanRuns.start('manual', timers.now())
    repos.scanRuns.finish(last.id, { status: 'succeeded', sourceResults: {} }, timers.now())
    scheduler.start()
    expect(timers.pendingAt()?.getTime()).toBe(timers.now().getTime() + HOUR)

    repos.settings.set(SCAN_INTERVAL_KEY, 15)
    scheduler.reschedule()
    expect(timers.pendingAt()?.getTime()).toBe(timers.now().getTime() + 15 * 60_000)

    // Below the minimum is ignored and the default applies.
    repos.settings.set(SCAN_INTERVAL_KEY, 1)
    scheduler.reschedule()
    expect(timers.pendingAt()?.getTime()).toBe(timers.now().getTime() + 6 * HOUR)
  })

  it('runs an overdue scan right away on start', () => {
    const { repos, scan, timers, scheduler } = setup()
    connect(repos)
    const last = repos.scanRuns.start('manual', new Date(timers.now().getTime() - 7 * HOUR))
    repos.scanRuns.finish(last.id, { status: 'succeeded', sourceResults: {} })
    scheduler.start()
    expect(timers.pendingAt()).toEqual(timers.now())
    timers.fire()
    expect(scan.calls.map((c) => c.trigger)).toEqual(['schedule'])
  })

  it('skips scheduled scans while nothing is connected', () => {
    const { repos, scan, timers, scheduler } = setup()
    scheduler.start()
    timers.fire()
    expect(scan.runScan).not.toHaveBeenCalled()
    expect(timers.pendingAt()).not.toBeNull()
    expect(repos.scanRuns.list()).toEqual([])
  })

  it('allows one scan at a time and returns the running one', async () => {
    const { scan, scheduler } = setup()
    const first = scheduler.scanNow()
    const second = scheduler.scanNow()
    expect(first.started).toBe(true)
    expect(second).toEqual({ started: false, run: first.run })
    expect(scan.runScan).toHaveBeenCalledTimes(1)
    expect(scheduler.progress()).toEqual({
      scanRunId: first.run.id,
      startedAt: first.run.startedAt,
      phase: 'alerts',
      done: 0,
      total: 2,
      skipped: ['lockfiles'],
    })

    scan.finish()
    await scheduler.idle()
    expect(scheduler.progress()).toBeNull()
    expect(scheduler.scanNow().started).toBe(true)
  })

  it('tells listeners about finished scans and survives listeners that fail', async () => {
    const { scan, scheduler, logger } = setup()
    const seen: number[] = []
    scheduler.onScanFinished(() => {
      throw new Error('discord is down')
    })
    scheduler.onScanFinished(() => Promise.reject(new Error('mail is down')))
    const unsubscribe = scheduler.onScanFinished((summary) => {
      seen.push(summary.scanRunId)
    })

    const { run } = scheduler.scanNow()
    scan.finish()
    await scheduler.idle()
    expect(seen).toEqual([run.id])
    const failures = logger.lines.filter((l) => l.message === 'scheduler: a scan listener failed')
    expect(failures.map((l) => l.data?.error)).toEqual(['discord is down', 'mail is down'])

    unsubscribe()
    scheduler.scanNow()
    scan.finish()
    await scheduler.idle()
    expect(seen).toEqual([run.id])
  })

  it('fails the run when the scan itself crashes, and keeps scheduling', async () => {
    const { repos } = createTestRepositories()
    const timers = manualTimers()
    const logger = recordingLogger()
    const runScan = vi.fn((storage: { repositories: Repositories }) => {
      storage.repositories.scanRuns.start('manual', timers.now())
      return Promise.reject(new Error('disk full'))
    })
    const scheduler = createScheduler({
      repositories: repos,
      log: logger.log,
      now: timers.now,
      buildSources: () => EMPTY_SOURCES,
      runScan,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    scheduler.start()
    const { run } = scheduler.scanNow()
    await scheduler.idle()
    expect(repos.scanRuns.get(run.id)).toMatchObject({ status: 'failed', error: 'disk full' })
    expect(timers.pendingAt()).not.toBeNull()
  })

  it('stops planning after stop()', () => {
    const { repos, timers, scheduler } = setup()
    connect(repos)
    scheduler.start()
    scheduler.stop()
    expect(timers.pendingAt()).toBeNull()
    expect(scheduler.nextScanAt()).toBeNull()
  })

  describe('shutdown', () => {
    it('resolves at once when no scan runs, and refuses new scans after', async () => {
      const { repos, timers, scheduler } = setup()
      connect(repos)
      scheduler.start()
      expect(await scheduler.shutdown(1_000)).toEqual({ drained: true })
      expect(timers.pendingAt()).toBeNull()
      expect(() => scheduler.scanNow()).toThrow(SchedulerClosedError)
    })

    it('waits for the running scan to finish before resolving', async () => {
      const { repos, scan, scheduler } = setup()
      const { run } = scheduler.scanNow()
      let resolved = false
      const done = scheduler.shutdown(5_000).then((r) => {
        resolved = true
        return r
      })
      await Promise.resolve()
      expect(resolved).toBe(false)
      scan.finish()
      expect(await done).toEqual({ drained: true })
      expect(repos.scanRuns.get(run.id)?.status).toBe('succeeded')
    })

    it('marks the scan interrupted when it does not finish in time', async () => {
      vi.useFakeTimers()
      try {
        const { repos, scan, scheduler, logger } = setup()
        const { run } = scheduler.scanNow()
        const done = scheduler.shutdown(2_000)
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await done).toEqual({ drained: false })
        expect(repos.scanRuns.get(run.id)).toMatchObject({
          status: 'failed',
          error: INTERRUPTED_SCAN_MESSAGE,
        })
        expect(logger.lines.some((l) => l.message.includes('marked interrupted'))).toBe(true)
        // A scan that ends late afterwards does not crash the scheduler.
        scan.finish()
        await scheduler.idle()
      } finally {
        vi.useRealTimers()
      }
    })

    it('waits for the configured time, no longer and no shorter', async () => {
      vi.useFakeTimers()
      try {
        const { repos, scheduler } = setup({ shutdownTimeoutMs: 30_000 })
        const { run } = scheduler.scanNow()
        let result: { drained: boolean } | undefined
        void scheduler.shutdown().then((r) => (result = r))
        await vi.advanceTimersByTimeAsync(29_999)
        expect(result).toBeUndefined()
        expect(repos.scanRuns.get(run.id)?.status).toBe('running')
        await vi.advanceTimersByTimeAsync(1)
        expect(result).toEqual({ drained: false })
        expect(repos.scanRuns.get(run.id)?.status).toBe('failed')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
