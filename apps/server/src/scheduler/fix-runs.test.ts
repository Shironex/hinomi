import { describe, expect, it } from 'vitest'
import { startFixRunTracking } from './fix-runs.js'

// The timer around the fix run tracker, with timers fired by hand.

function timers() {
  const pending: { fn: () => void; ms: number }[] = []
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms }
      pending.push(timer)
      return timer
    },
    clearTimer: (handle: unknown) => {
      const at = pending.indexOf(handle as { fn: () => void; ms: number })
      if (at >= 0) pending.splice(at, 1)
    },
    fire() {
      const next = pending.shift()
      if (!next) throw new Error('no timer planned')
      next.fn()
    },
  }
}

const now = () => new Date('2026-11-07T10:00:00.000Z')

describe('fix run tracking timer', () => {
  it('ticks at once, then at the delay each tick asks for', async () => {
    const t = timers()
    const delays = [20_000, 5_000]
    let ticks = 0
    const timer = startFixRunTracking({
      ticker: {
        tick: () => {
          ticks += 1
          return Promise.resolve({ nextDelayMs: delays.shift() ?? 60_000 })
        },
      },
      now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    expect(t.pending.map((p) => p.ms)).toEqual([0])
    t.fire()
    await timer.idle()
    expect(ticks).toBe(1)
    expect(t.pending.map((p) => p.ms)).toEqual([20_000])
    expect(timer.nextAt()).toEqual(new Date('2026-11-07T10:00:20.000Z'))
    t.fire()
    await timer.idle()
    expect(t.pending.map((p) => p.ms)).toEqual([5_000])
    timer.stop()
    expect(t.pending).toEqual([])
    expect(timer.nextAt()).toBeNull()
  })

  it('keeps going after a tick that throws, and plans nothing once stopped', async () => {
    const t = timers()
    const errors: string[] = []
    let fail = true
    const timer = startFixRunTracking({
      ticker: {
        tick: () =>
          fail ? Promise.reject(new Error('boom')) : Promise.resolve({ nextDelayMs: 1 }),
      },
      log: { info() {}, warn() {}, error: (message) => errors.push(message) },
      now,
      errorDelayMs: 30_000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    t.fire()
    await timer.idle()
    expect(errors).toEqual(['tracker: a tick failed'])
    expect(t.pending.map((p) => p.ms)).toEqual([30_000])
    fail = false
    t.fire()
    timer.stop()
    await timer.idle()
    expect(t.pending).toEqual([])
  })
})
