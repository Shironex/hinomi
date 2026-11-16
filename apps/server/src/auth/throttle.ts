/**
 * Backoff for failed logins, per key (`ip:<address>`, `account:<name>`). A few failures are free;
 * after that each one locks the key for twice as long as the last, up to a ceiling. A success
 * clears the keys it names. In memory: a restart forgets, which only ever helps a person who
 * locked themselves out, and the ceiling still bounds an attacker to a handful of tries an hour.
 */

export interface ThrottleOptions {
  /** Failures allowed before the first lock. */
  freeFailures?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** A key with no failure for this long is forgotten. */
  forgetAfterMs?: number
  /** Most keys kept; the oldest are dropped first when an attack fills the table. */
  maxKeys?: number
  now?: () => number
}

interface Entry {
  failures: number
  lockedUntil: number
  lastFailureAt: number
}

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterMs: number }

export function createThrottle({
  freeFailures = 5,
  baseDelayMs = 1000,
  maxDelayMs = 15 * 60 * 1000,
  forgetAfterMs = 60 * 60 * 1000,
  maxKeys = 10_000,
  now = Date.now,
}: ThrottleOptions = {}) {
  const entries = new Map<string, Entry>()

  function live(key: string): Entry | undefined {
    const entry = entries.get(key)
    if (entry && now() - entry.lastFailureAt > forgetAfterMs) {
      entries.delete(key)
      return undefined
    }
    return entry
  }

  return {
    /** Whether an attempt for these keys may run now; the longest lock wins. */
    check(keys: readonly string[]): ThrottleVerdict {
      let wait = 0
      for (const key of keys) {
        const entry = live(key)
        if (entry) wait = Math.max(wait, entry.lockedUntil - now())
      }
      return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true }
    },

    fail(keys: readonly string[]): void {
      const at = now()
      for (const key of keys) {
        const entry = live(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: at }
        entry.failures += 1
        entry.lastFailureAt = at
        const over = entry.failures - freeFailures
        if (over > 0) entry.lockedUntil = at + Math.min(maxDelayMs, baseDelayMs * 2 ** (over - 1))
        // Re-insert so the map stays ordered by last failure, oldest first.
        entries.delete(key)
        entries.set(key, entry)
      }
      while (entries.size > maxKeys) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },

    succeed(keys: readonly string[]): void {
      for (const key of keys) entries.delete(key)
    },
  }
}

export type Throttle = ReturnType<typeof createThrottle>
