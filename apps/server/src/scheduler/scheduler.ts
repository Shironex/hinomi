import {
  SCAN_INTERVAL_DEFAULT_MINUTES,
  SCAN_INTERVAL_MAX_MINUTES,
  SCAN_INTERVAL_MIN_MINUTES,
  type ScanTrigger,
} from '@hinomi/shared'
import { z } from 'zod'
import { readOnboarding } from '../api/routes/onboarding.js'
import type { ScanRunRow } from '../db/schema.js'
import { DEFAULT_SHUTDOWN_TIMEOUT_SECONDS } from '../config.js'
import { silentLogger, type Logger } from '../log.js'
import type { Repositories, SettingsRepository } from '../repository/index.js'
import {
  buildScanSources,
  runScan,
  type RunScanOptions,
  type ScanProgress,
  type ScanSources,
  type ScanSummary,
} from '../scan/index.js'
import { errorMessage } from '../scan/collect.js'

/** Settings key of the scan interval, in minutes (plain JSON number). */
export const SCAN_INTERVAL_KEY = 'scan.intervalMinutes'

const intervalSchema = z
  .number()
  .int()
  .min(SCAN_INTERVAL_MIN_MINUTES)
  .max(SCAN_INTERVAL_MAX_MINUTES)

export function readScanIntervalMinutes(settings: SettingsRepository): number {
  return settings.get(SCAN_INTERVAL_KEY, intervalSchema) ?? SCAN_INTERVAL_DEFAULT_MINUTES
}

/** Message stored on a scan run that a crash or restart left running. */
export const INTERRUPTED_SCAN_MESSAGE = 'Interrupted: the server stopped before the scan finished'

export type ScanFinishedListener = (summary: ScanSummary) => void | Promise<void>

export interface StartScanResult {
  /** False when a scan was already running; `run` is that scan. */
  started: boolean
  run: ScanRunRow
}

export interface ScanProgressState extends ScanProgress {
  scanRunId: number
  startedAt: Date
}

/** Thrown by `scanNow` once `shutdown` was called: no new scan starts while the server stops. */
export class SchedulerClosedError extends Error {
  constructor() {
    super('The server is shutting down, so no new scan starts')
    this.name = 'SchedulerClosedError'
  }
}

/** How long shutdown waits for a running scan when nothing is configured. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS * 1000

export interface Scheduler {
  /** Fails runs a crash left `running`, then plans the next scan (now, when one is overdue). */
  start(): void
  /** Stops the timer. A scan in progress finishes on its own; await `idle()` to wait for it. */
  stop(): void
  /** Starts a scan unless one is running, in which case that one is returned. */
  scanNow(trigger?: ScanTrigger): StartScanResult
  /** Re-reads the interval and sources and plans the next scan again (after a settings change). */
  reschedule(): void
  /**
   * Subscribes to finished scans (notifications use it). A listener that throws or rejects is
   * logged and never affects the scheduler or other listeners. Returns an unsubscribe function.
   */
  onScanFinished(listener: ScanFinishedListener): () => void
  /** The scan in progress, or null. */
  progress(): ScanProgressState | null
  /** When the next scheduled scan starts, or null when none is planned. */
  nextScanAt(): Date | null
  /** Resolves when no scan is running (for tests and shutdown). */
  idle(): Promise<void>
  /**
   * Stops the timer, refuses new scans and waits up to `timeoutMs` (default: the
   * `shutdownTimeoutMs` option) for the running one. On timeout the run is marked interrupted so storage can
   * close. Resolves `drained` when no scan was left running.
   */
  shutdown(timeoutMs?: number): Promise<{ drained: boolean }>
}

export interface SchedulerOptions {
  repositories: Repositories
  log?: Logger
  /** How long `shutdown()` waits for a running scan. Defaults to DEFAULT_SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number
  now?: () => Date
  /** Builds the sources for one scan. Defaults to buildScanSources over storage. */
  buildSources?: (repositories: Repositories) => ScanSources
  /** The scan itself. Tests swap it for a controllable fake. */
  runScan?: (
    storage: { repositories: Repositories },
    sources: ScanSources,
    options: RunScanOptions,
  ) => Promise<ScanSummary>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** setTimeout fires at once for delays above 2^31 - 1 ms (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  // A pending scan must not keep the process alive on shutdown.
  handle.unref()
  return handle
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * True when there is something to scan: an enabled Coolify or GitHub source
 * with a token. Without one, scheduled scans are skipped.
 */
export function isConfigured(repositories: Repositories): boolean {
  return repositories.sources
    .list()
    .some((s) => s.enabled && s.hasToken && (s.kind === 'coolify' || s.kind === 'github'))
}

/**
 * True when a scan may start on its own (first boot or schedule): something is
 * connected, and either GitHub is connected or setup is finished. A scan with
 * only Coolify, halfway through setup, would report every repo as unchecked.
 * Manual scans are never held back.
 */
export function canAutoScan(repositories: Repositories): boolean {
  if (!isConfigured(repositories)) return false
  const github = repositories.sources.listByKind('github').some((s) => s.enabled && s.hasToken)
  return github || readOnboarding(repositories).finished
}

/**
 * Runs scans on the configured interval (default every 6 h, at least every
 * 15 min) and on demand, one at a time. Single process: the in-memory lock is
 * the source of truth, and runs left `running` in the database by a crash are
 * failed on start.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { repositories } = options
  const log = options.log ?? silentLogger
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const now = options.now ?? (() => new Date())
  const build = options.buildSources ?? ((repos: Repositories) => buildScanSources(repos))
  const scan = options.runScan ?? runScan
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer = options.clearTimer ?? defaultClearTimer

  const listeners = new Set<ScanFinishedListener>()
  let active: {
    promise: Promise<void>
    runId: number | null
    startedAt: Date
    progress: ScanProgress
  } | null = null
  let timer: unknown = null
  let nextAt: Date | null = null
  let running = false
  let closed = false

  function failRun(run: ScanRunRow, error: string): void {
    repositories.scanRuns.finish(
      run.id,
      { status: 'failed', sourceResults: run.sourceResults, error },
      now(),
    )
  }

  function recoverInterrupted(): void {
    let stale = repositories.scanRuns.running()
    while (stale) {
      failRun(stale, INTERRUPTED_SCAN_MESSAGE)
      log.warn('scheduler: marked an interrupted scan as failed', { scanRunId: stale.id })
      stale = repositories.scanRuns.running()
    }
  }

  function clear(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    nextAt = null
  }

  function plan(at: Date, trigger: ScanTrigger): void {
    clear()
    if (!running) return
    nextAt = at
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at.getTime() - now().getTime()))
    timer = setTimer(() => {
      timer = null
      // A long interval is split into several timers; only fire once it is due.
      if (nextAt && nextAt.getTime() > now().getTime()) {
        plan(nextAt, trigger)
        return
      }
      nextAt = null
      if (!canAutoScan(repositories)) {
        log.info('scheduler: setup is not finished, skipping the scheduled scan')
        planNext()
        return
      }
      try {
        scanNow(trigger)
      } catch (error) {
        log.error('scheduler: could not start the scheduled scan', { error: errorMessage(error) })
        planNext()
      }
    }, delay)
  }

  /** Next scan: one interval after the latest run started, or now when that is overdue. */
  function planNext(): void {
    if (!running || active) return
    const intervalMs = readScanIntervalMinutes(repositories.settings) * 60_000
    const latest = repositories.scanRuns.latest()
    if (!latest) {
      // First scan right away once GitHub is connected or setup is finished.
      if (canAutoScan(repositories)) plan(now(), 'boot')
      else plan(new Date(now().getTime() + intervalMs), 'schedule')
      return
    }
    const due = new Date(latest.startedAt.getTime() + intervalMs)
    plan(due.getTime() <= now().getTime() ? now() : due, 'schedule')
  }

  async function notify(summary: ScanSummary): Promise<void> {
    for (const listener of [...listeners]) {
      try {
        await listener(summary)
      } catch (error) {
        log.error('scheduler: a scan listener failed', { error: errorMessage(error) })
      }
    }
  }

  async function execute(trigger: ScanTrigger, sources: ScanSources): Promise<void> {
    const state = active!
    try {
      const summary = await scan({ repositories }, sources, {
        trigger,
        now,
        log,
        onProgress: (progress) => {
          state.progress = progress
        },
      })
      await notify(summary)
    } catch (error) {
      // runScan never throws by contract; this guards against a broken fake or a future change.
      log.error('scheduler: scan crashed', { error: errorMessage(error) })
      try {
        const run = state.runId === null ? undefined : repositories.scanRuns.get(state.runId)
        if (run?.status === 'running') failRun(run, errorMessage(error))
      } catch (inner) {
        // Storage may already be closed after a shutdown timeout.
        log.error('scheduler: could not record the crash', { error: errorMessage(inner) })
      }
    } finally {
      active = null
      planNext()
    }
  }

  function stop(): void {
    running = false
    clear()
  }

  async function idle(): Promise<void> {
    while (active) await active.promise
  }

  function scanNow(trigger: ScanTrigger = 'manual'): StartScanResult {
    if (closed) throw new SchedulerClosedError()
    if (active) {
      const run =
        (active.runId !== null ? repositories.scanRuns.get(active.runId) : undefined) ??
        repositories.scanRuns.running()
      if (run) return { started: false, run }
    }
    const sources = build(repositories)
    clear()
    const state: NonNullable<typeof active> = {
      promise: Promise.resolve(),
      runId: null,
      startedAt: now(),
      progress: { phase: 'deployments', done: 0, total: 0, skipped: [] },
    }
    active = state
    state.promise = execute(trigger, sources)
    // runScan writes the run row before its first await, so it exists by now.
    const run = repositories.scanRuns.running()
    if (!run) {
      throw new Error('The scan did not record a run')
    }
    state.runId = run.id
    state.startedAt = run.startedAt
    return { started: true, run }
  }

  return {
    start() {
      if (running) return
      running = true
      recoverInterrupted()
      planNext()
      log.info('scheduler: started', {
        intervalMinutes: readScanIntervalMinutes(repositories.settings),
        nextScanAt: nextAt?.toISOString() ?? null,
      })
    },

    stop,

    scanNow,

    reschedule() {
      if (active) return
      planNext()
    },

    onScanFinished(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    progress() {
      if (!active || active.runId === null) return null
      return { scanRunId: active.runId, startedAt: active.startedAt, ...active.progress }
    },

    nextScanAt() {
      return nextAt
    },

    idle,

    async shutdown(timeoutMs = shutdownTimeoutMs) {
      closed = true
      stop()
      const state = active
      if (!state) return { drained: true }
      log.info('scheduler: waiting for the running scan', { scanRunId: state.runId, timeoutMs })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([
        idle().then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      clearTimeout(timeout)
      if (drained) return { drained: true }
      const run = state.runId === null ? undefined : repositories.scanRuns.get(state.runId)
      if (run?.status === 'running') failRun(run, INTERRUPTED_SCAN_MESSAGE)
      log.warn('scheduler: the scan did not finish in time and was marked interrupted', {
        scanRunId: state.runId,
      })
      return { drained: false }
    },
  }
}
