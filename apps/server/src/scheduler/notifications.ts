import { silentLogger, type Logger } from '../log.js'
import { msUntilNextDigest, readNotifySettings, type Notifier } from '../notify/index.js'
import type { SettingsRepository } from '../repository/index.js'
import type { Scheduler } from './scheduler.js'
import { currentTime } from '@hinomi/shared'

/** Sends every finished scan to the notifier. Returns the unsubscribe function. */
export function connectNotifier(
  scheduler: Pick<Scheduler, 'onScanFinished'>,
  notifier: Pick<Notifier, 'handleScanFinished'>,
): () => void {
  return scheduler.onScanFinished((summary) => notifier.handleScanFinished(summary))
}

export interface DigestTimer {
  /** Re-reads the digest hour and plans the next digest (after a settings change). */
  rearm(): void
  stop(): void
  /** When the next digest goes out, or null when stopped. */
  nextAt(): Date | null
}

export interface DigestTimerOptions {
  notifier: Pick<Notifier, 'sendDigest'>
  settings: SettingsRepository
  log?: Logger
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  handle.unref()
  return handle
}

/**
 * Sends the daily digest at the configured hour (server local time). The
 * timer is planned again after every run, reading the hour each time.
 */
export function startDigestTimer(options: DigestTimerOptions): DigestTimer {
  const log = options.log ?? silentLogger
  const now = options.now ?? (() => currentTime())
  const setTimer = options.setTimer ?? defaultSetTimer
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let next: Date | null = null
  let stopped = false

  function arm(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    next = null
    if (stopped) return
    const { digestHour } = readNotifySettings(options.settings)
    const ms = msUntilNextDigest(now(), digestHour)
    next = new Date(now().getTime() + ms)
    timer = setTimer(() => {
      timer = null
      options.notifier
        .sendDigest()
        .catch((error: unknown) => {
          // sendDigest never throws by contract; guard anyway so the timer keeps going.
          log.error('notify: digest failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(arm)
    }, ms)
  }

  arm()
  return {
    rearm: arm,
    stop() {
      stopped = true
      arm()
    },
    nextAt: () => next,
  }
}
