import { describe, expect, it } from 'vitest'
import { startSupportRefresh, SUPPORT_FIRST_DELAY_MS } from './support.js'

// The daily refresh timer, with timers fired by hand.

describe('support refresh timer', () => {
  it('waits before the first look, then follows the delay each look asks for', async () => {
    const pending: { fn: () => void; ms: number }[] = []
    const delays = [86_400_000, 1_800_000]
    let ticks = 0
    const timer = startSupportRefresh({
      support: {
        tick: () => {
          ticks += 1
          return Promise.resolve({ nextDelayMs: delays.shift() ?? 3_600_000 })
        },
      },
      setTimer: (fn, ms) => {
        const entry = { fn, ms }
        pending.push(entry)
        return entry
      },
      clearTimer: (handle) => {
        const at = pending.indexOf(handle as (typeof pending)[number])
        if (at >= 0) pending.splice(at, 1)
      },
    })
    expect(pending.map((p) => p.ms)).toEqual([SUPPORT_FIRST_DELAY_MS])
    pending.shift()?.fn()
    await timer.idle()
    expect(ticks).toBe(1)
    expect(pending.map((p) => p.ms)).toEqual([86_400_000])
    pending.shift()?.fn()
    await timer.idle()
    expect(pending.map((p) => p.ms)).toEqual([1_800_000])
    timer.stop()
    expect(pending).toEqual([])
  })
})
