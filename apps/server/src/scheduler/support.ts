import { silentLogger, type Logger } from '../log.js'
import { startFixRunTracking, type FixRunTrackingTimer } from './fix-runs.js'

// The daily refresh of the endoflife.date data. The support data decides when it is due (a copy
// under a day old, or no demand for it, only plans the next look), this runs its ticks one
// after another at the delay each one asks for, like the fix run tracking timer.

/** The first look waits a little, so a boot (and a restart loop) never hits the API at once. */
export const SUPPORT_FIRST_DELAY_MS = 60 * 1000

export interface SupportRefreshTimerOptions {
  support: { tick(): Promise<{ nextDelayMs: number }> }
  log?: Logger
  firstDelayMs?: number
  now?: () => Date
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function startSupportRefresh(options: SupportRefreshTimerOptions): FixRunTrackingTimer {
  return startFixRunTracking({
    ticker: options.support,
    log: options.log ?? silentLogger,
    firstDelayMs: options.firstDelayMs ?? SUPPORT_FIRST_DELAY_MS,
    errorDelayMs: 60 * 60 * 1000,
    ...(options.now && { now: options.now }),
    ...(options.setTimer && { setTimer: options.setTimer }),
    ...(options.clearTimer && { clearTimer: options.clearTimer }),
  })
}
