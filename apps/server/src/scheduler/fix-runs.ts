import { currentTime } from '@hinomi/shared'
import { silentLogger, type Logger } from '../log.js'

// The timer that drives fix run tracking. The tracker itself lives with the runner (it talks to
// GitHub, which the scheduler does not); this only runs its ticks one after another, at the
// delay each tick asks for, and keeps going when one fails.

/** What the timer needs from the fix run tracker. */
export interface FixRunTicker {
  tick(): Promise<{ nextDelayMs: number }>
}

export interface FixRunTrackingTimer {
  /** Stops planning ticks. A tick in progress finishes; await `idle()` for it. */
  stop(): void
  /** Resolves when no tick is running. */
  idle(): Promise<void>
  /** When the next tick runs, or null once stopped. */
  nextAt(): Date | null
  /**
   * Brings the next tick forward to within `wakeDelayMs` (runs were asked for by a webhook).
   * A burst of calls makes one tick; during a tick, the next one follows it that soon.
   */
  wake(): void
}

export interface FixRunTrackingTimerOptions {
  ticker: FixRunTicker
  log?: Logger
  now?: () => Date
  /** Delay of the first tick. Defaults to 0 (right after start). */
  firstDelayMs?: number
  /** Delay after a tick that threw. */
  errorDelayMs?: number
  /** How soon a `wake` ticks, so a burst of webhook deliveries is polled together. */
  wakeDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  // Polling must not keep the process alive on shutdown.
  handle.unref()
  return handle
}

/** Starts ticking the tracker until `stop`. */
export function startFixRunTracking(options: FixRunTrackingTimerOptions): FixRunTrackingTimer {
  const log = options.log ?? silentLogger
  const now = options.now ?? currentTime
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const errorDelayMs = options.errorDelayMs ?? 60_000
  const wakeDelayMs = options.wakeDelayMs ?? 2_000
  let timer: unknown = null
  let next: Date | null = null
  let active: Promise<void> | null = null
  let stopped = false
  /** A wake arrived during a tick. */
  let woken = false

  function plan(ms: number): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    next = null
    if (stopped) return
    const delay = Math.max(0, ms)
    next = new Date(now().getTime() + delay)
    timer = setTimer(fire, delay)
  }

  function fire(): void {
    woken = false
    timer = null
    next = null
    if (stopped) return
    active = options.ticker
      .tick()
      .then(
        (result) => plan(woken ? Math.min(result.nextDelayMs, wakeDelayMs) : result.nextDelayMs),
        (error: unknown) => {
          // tick never throws by contract; guard anyway so tracking keeps going.
          log.error('tracker: a tick failed', {
            error: error instanceof Error ? error.message : String(error),
          })
          plan(errorDelayMs)
        },
      )
      .finally(() => {
        active = null
        woken = false
      })
  }

  plan(options.firstDelayMs ?? 0)
  return {
    stop() {
      stopped = true
      plan(0)
    },
    async idle() {
      while (active) await active
    },
    nextAt: () => next,
    wake() {
      if (stopped) return
      if (active) {
        woken = true
        return
      }
      if (next && next.getTime() <= now().getTime() + wakeDelayMs) return
      plan(wakeDelayMs)
    },
  }
}
