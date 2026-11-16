import { describe, expect, it } from 'vitest'
import { createThrottle } from './throttle.js'

describe('createThrottle', () => {
  function setup() {
    const clock = { now: 1_000_000 }
    return { clock, throttle: createThrottle({ now: () => clock.now }) }
  }

  it('lets five failures through, then doubles the lock', () => {
    const { clock, throttle } = setup()
    for (let i = 0; i < 5; i++) throttle.fail(['ip:1'])
    expect(throttle.check(['ip:1'])).toEqual({ allowed: true })
    throttle.fail(['ip:1'])
    expect(throttle.check(['ip:1'])).toEqual({ allowed: false, retryAfterMs: 1000 })
    clock.now += 1000
    throttle.fail(['ip:1'])
    expect(throttle.check(['ip:1'])).toEqual({ allowed: false, retryAfterMs: 2000 })
    clock.now += 2000
    throttle.fail(['ip:1'])
    expect(throttle.check(['ip:1'])).toEqual({ allowed: false, retryAfterMs: 4000 })
  })

  it('caps the lock at 15 minutes', () => {
    const { throttle } = setup()
    for (let i = 0; i < 40; i++) throttle.fail(['account:setup'])
    expect(throttle.check(['account:setup'])).toEqual({
      allowed: false,
      retryAfterMs: 15 * 60 * 1000,
    })
  })

  it('locks when any key is locked, and a success clears only its keys', () => {
    const { throttle } = setup()
    for (let i = 0; i < 6; i++) throttle.fail(['ip:1', 'account:setup'])
    expect(throttle.check(['ip:2', 'account:setup']).allowed).toBe(false)
    throttle.succeed(['ip:1'])
    expect(throttle.check(['ip:1']).allowed).toBe(true)
    expect(throttle.check(['account:setup']).allowed).toBe(false)
  })

  it('forgets a key an hour after its last failure', () => {
    const { clock, throttle } = setup()
    for (let i = 0; i < 6; i++) throttle.fail(['ip:1'])
    clock.now += 60 * 60 * 1000 + 1
    throttle.fail(['ip:1'])
    expect(throttle.check(['ip:1']).allowed).toBe(true)
  })

  it('stays bounded when an attack sprays keys', () => {
    const clock = { now: 0 }
    const throttle = createThrottle({ now: () => clock.now, maxKeys: 3, freeFailures: 0 })
    for (const key of ['a', 'b', 'c', 'd']) throttle.fail([key])
    expect(throttle.check(['a']).allowed).toBe(true)
    expect(throttle.check(['d']).allowed).toBe(false)
  })
})
