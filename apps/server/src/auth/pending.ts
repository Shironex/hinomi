/**
 * Short lived, single use entries in memory: WebAuthn challenges and OAuth login attempts. `take`
 * removes the entry, so a replayed answer finds nothing. Bounded twice: in total, so callers that
 * ask in a loop only push out the oldest entries, and per owner (a client address), so one client
 * pushes out only its own entries while others stay.
 */
export function createPendingStore<T>({
  ttlMs,
  maxEntries = 1000,
  maxPerOwner = Number.POSITIVE_INFINITY,
  now = Date.now,
}: {
  ttlMs: number
  maxEntries?: number
  maxPerOwner?: number
  now?: () => number
}) {
  const entries = new Map<string, { value: T; expiresAt: number; owner: string | null }>()

  function sweep(): void {
    const at = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key)
    }
  }

  function dropOldest(match: (owner: string | null) => boolean): boolean {
    for (const [key, entry] of entries) {
      if (match(entry.owner)) {
        entries.delete(key)
        return true
      }
    }
    return false
  }

  return {
    put(key: string, value: T, owner: string | null = null): void {
      if (owner !== null) {
        let mine = 0
        for (const entry of entries.values()) if (entry.owner === owner) mine++
        if (mine >= maxPerOwner) sweep()
        while (mine >= maxPerOwner && dropOldest((o) => o === owner)) mine--
      }
      if (entries.size >= maxEntries) sweep()
      while (entries.size >= maxEntries && dropOldest(() => true)) {
        // keep dropping the oldest until there is room
      }
      entries.set(key, { value, expiresAt: now() + ttlMs, owner })
    },

    /** The entry for `key` if it has not expired; removed either way. */
    take(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      return entry.expiresAt > now() ? entry.value : undefined
    },

    get size(): number {
      return entries.size
    },
  }
}

export type PendingStore<T> = ReturnType<typeof createPendingStore<T>>
