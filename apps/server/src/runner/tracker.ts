import { currentTime } from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'
import { silentLogger, type Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import { GithubRateLimitError, type GithubClient } from '../sources/github/index.js'
import { cachedRunnerGithub, type RunnerGithub } from './github.js'
import { pollFixRun, type PollContext, type RunTrackingState } from './tracker-poll.js'
import {
  FIX_RUN_TRACKING,
  WATCHED_ENDED_STATES,
  pollIntervalMs,
  trackingPhase,
  type FixRunTrackingConfig,
  type TrackingPhase,
} from './tracking.js'

// The fix run tracker: polls GitHub for every run that is still moving and for recently
// ended runs that may come back, at a cadence per state, within a request budget shared by all
// runs, and backs off when GitHub's rate limit runs low. The scheduler calls `tick` on a timer;
// polling one run is in tracker-poll.ts.

/** A short wait inside the client; a longer rate limit pauses the tracker instead. */
const TRACKER_MAX_WAIT_MS = 10_000

export interface FixRunTrackerOptions {
  repositories: Repositories
  log?: Logger
  now?: () => Date
  /** Fetch for GitHub and the artifact download. Replaced in tests. */
  fetch?: typeof fetch
  /** Public address of this Hinomi, read per publish (fix PRs of private repos link to it). */
  publicBaseUrl?: () => string | null
  /** Overrides cadences and caps (tests). */
  config?: Partial<FixRunTrackingConfig>
  /** Replaces the GitHub source (tests). */
  github?: () => RunnerGithub
}

/** What the tracker knows about one run, for the run's API answer. */
export interface FixRunTrackingView {
  lastPolledAt: Date | null
  /** Null when the run is no longer followed. */
  nextPollAt: Date | null
  lastError: string | null
  /** Set while the tracker waits for GitHub's rate limit window. */
  pausedUntil: Date | null
}

export interface FixRunTickSummary {
  /** Runs polled in this tick. */
  polled: number
  /** GitHub requests made. */
  requests: number
  pausedUntil: Date | null
  /** When the scheduler should tick again. */
  nextDelayMs: number
}

export interface FixRunTracker {
  /** Polls the runs that are due. Never throws for GitHub errors; one tick at a time. */
  tick(): Promise<FixRunTickSummary>
  /** The tracking state of a run, or null when the tracker never looked at it. */
  status(run: FixRunRow): FixRunTrackingView | null
}

interface Due {
  run: FixRunRow
  phase: TrackingPhase
  at: number
}

/** Counts requests per tick and per rolling hour, and reads GitHub's rate limit headers. */
class RequestMeter {
  readonly #config: FixRunTrackingConfig
  readonly #now: () => number
  readonly #hour: number[] = []
  #tick = 0
  pausedUntil = 0

  constructor(config: FixRunTrackingConfig, now: () => number) {
    this.#config = config
    this.#now = now
  }

  startTick(): void {
    this.#tick = 0
    const cutoff = this.#now() - 3_600_000
    while (this.#hour.length > 0 && (this.#hour[0] ?? 0) < cutoff) this.#hour.shift()
  }

  get tickRequests(): number {
    return this.#tick
  }

  /** True when no new run should start in this tick. */
  exhausted(): boolean {
    return (
      this.paused() ||
      this.#tick >= this.#config.requestsPerTick ||
      this.#hour.length >= this.#config.requestsPerHour
    )
  }

  paused(): boolean {
    return this.pausedUntil > this.#now()
  }

  /** When the rolling hour frees a request again, for the next tick. */
  hourFreesAt(): number | null {
    if (this.#hour.length < this.#config.requestsPerHour) return null
    return (this.#hour[0] ?? this.#now()) + 3_600_000
  }

  pauseUntil(ms: number): void {
    if (ms > this.pausedUntil) this.pausedUntil = ms
  }

  count(): void {
    this.#tick += 1
    this.#hour.push(this.#now())
  }

  /** Stays clear of the limit: below the reserve, wait for the window to reset. */
  observe(headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? 'NaN')
    const reset = Number(headers.get('x-ratelimit-reset') ?? 'NaN')
    if (Number.isFinite(remaining) && remaining < this.#config.rateLimitReserve) {
      this.pauseUntil(Number.isFinite(reset) ? reset * 1000 + 1000 : this.#now() + 60_000)
    }
  }

  failed(error: unknown): void {
    if (error instanceof GithubRateLimitError) this.pauseUntil(error.retryAt)
  }
}

function meteredClient(client: GithubClient, meter: RequestMeter): GithubClient {
  return {
    baseUrl: client.baseUrl,
    async rest(path, options) {
      meter.count()
      try {
        const result = await client.rest(path, options)
        meter.observe(result.headers)
        return result
      } catch (error) {
        meter.failed(error)
        throw error
      }
    },
    async graphql(query, variables) {
      meter.count()
      try {
        return await client.graphql(query, variables)
      } catch (error) {
        meter.failed(error)
        throw error
      }
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createFixRunTracker(options: FixRunTrackerOptions): FixRunTracker {
  const { repositories } = options
  const log = options.log ?? silentLogger
  const now = options.now ?? currentTime
  const config: FixRunTrackingConfig = { ...FIX_RUN_TRACKING, ...options.config }
  const github =
    options.github ??
    cachedRunnerGithub(repositories, {
      ...(options.fetch && { fetch: options.fetch }),
      // The tracker's clock, so a rate limit's retry time and the pause agree.
      client: { maxWaitMs: TRACKER_MAX_WAIT_MS, now: () => now().getTime() },
    })
  const meter = new RequestMeter(config, () => now().getTime())
  const states = new Map<number, RunTrackingState>()
  let running: Promise<FixRunTickSummary> | null = null

  function stateOf(runId: number): RunTrackingState {
    let state = states.get(runId)
    if (!state) {
      state = { lastPolledAt: null, lastError: null, publishAttempts: 0, retryAt: null }
      states.set(runId, state)
    }
    return state
  }

  function dueAt(run: FixRunRow, phase: TrackingPhase, at: Date): number {
    const state = states.get(run.id)
    if (state?.retryAt) return state.retryAt.getTime()
    if (!state?.lastPolledAt) return at.getTime()
    return state.lastPolledAt.getTime() + pollIntervalMs(run, phase, at, config)
  }

  /** Every followed run with its phase and due time; forgets runs no longer followed. */
  function followed(at: Date): Due[] {
    const since = new Date(at.getTime() - config.endedForMs)
    const rows = [
      ...repositories.fixRuns.listActive(),
      ...repositories.fixRuns.listEndedSince(since, WATCHED_ENDED_STATES),
    ]
    const list: Due[] = []
    const kept = new Set<number>()
    for (const run of rows) {
      const phase = trackingPhase(run, at, config)
      if (!phase) continue
      kept.add(run.id)
      list.push({ run, phase, at: dueAt(run, phase, at) })
    }
    for (const id of states.keys()) if (!kept.has(id)) states.delete(id)
    return list.sort((a, b) => a.at - b.at || a.run.id - b.run.id)
  }

  function nextDelay(list: Due[], at: Date): number {
    const t = at.getTime()
    let next = t + config.idleDelayMs
    for (const due of list) next = Math.min(next, due.at)
    if (meter.paused()) next = Math.max(next, meter.pausedUntil)
    const frees = meter.hourFreesAt()
    if (frees !== null) next = Math.max(next, frees)
    return Math.max(config.minDelayMs, next - t)
  }

  function summary(polled: number, list: Due[], at: Date): FixRunTickSummary {
    return {
      polled,
      requests: meter.tickRequests,
      pausedUntil: meter.paused() ? new Date(meter.pausedUntil) : null,
      nextDelayMs: nextDelay(list, at),
    }
  }

  async function runTick(): Promise<FixRunTickSummary> {
    const started = now()
    meter.startTick()
    let list = followed(started)
    const due = list.filter((d) => d.at <= started.getTime())
    if (due.length === 0 || meter.exhausted()) return summary(0, list, started)

    const source = github()
    if (!source.ok) {
      for (const { run } of due) {
        const state = stateOf(run.id)
        state.lastPolledAt = started
        state.lastError = source.message
      }
      return summary(0, followed(now()), now())
    }
    const client = meteredClient(source.source.client, meter)
    const metered: RunnerGithub = { ok: true, source: { ...source.source, client } }

    let polled = 0
    for (const { run, phase } of due) {
      if (meter.exhausted()) break
      const state = stateOf(run.id)
      state.lastError = null
      if (phase !== 'publish') state.retryAt = null
      const context: PollContext = {
        repositories,
        client,
        github: () => metered,
        fetch: options.fetch,
        now,
        log,
        config,
        publicBaseUrl: options.publicBaseUrl,
        state,
      }
      try {
        // A row read at the start of the tick may have moved (an API dispatch superseded it).
        const fresh = repositories.fixRuns.get(run.id)
        const phaseNow = fresh ? trackingPhase(fresh, now(), config) : null
        if (fresh && phaseNow) await pollFixRun(context, fresh, phaseNow)
      } catch (error) {
        state.lastError = errorText(error)
        log.warn('tracker: polling a fix run failed', {
          runId: run.id,
          phase,
          error: state.lastError,
        })
      } finally {
        state.lastPolledAt = now()
        polled += 1
      }
    }
    if (meter.paused()) {
      log.warn('tracker: GitHub rate limit is low, pausing fix run polling', {
        until: new Date(meter.pausedUntil).toISOString(),
      })
    }
    const ended = now()
    list = followed(ended)
    return summary(polled, list, ended)
  }

  return {
    tick() {
      if (!running) {
        running = runTick().finally(() => {
          running = null
        })
      }
      return running
    },

    status(run) {
      const state = states.get(run.id)
      if (!state) return null
      const at = now()
      const phase = trackingPhase(run, at, config)
      return {
        lastPolledAt: state.lastPolledAt,
        nextPollAt: phase ? new Date(Math.max(dueAt(run, phase, at), at.getTime())) : null,
        lastError: state.lastError,
        pausedUntil: meter.paused() ? new Date(meter.pausedUntil) : null,
      }
    },
  }
}
