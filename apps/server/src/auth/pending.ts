/**
 * Short lived, single use entries in memory: WebAuthn challenges and OAuth login attempts. `take`
 * removes the entry, so a replayed answer finds nothing. Bounded, so unauthenticated callers that
 * ask for challenges in a loop only push out the oldest ones.
 */
export function createPendingStore<T>({
  ttlMs,
  maxEntries = 1000,
  now = Date.now,
}: {
  ttlMs: number
  maxEntries?: number
  now?: () => number
}) {
  const entries = new Map<string, { value: T; expiresAt: number }>()

  function sweep(): void {
    const at = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key)
    }
  }

  return {
    put(key: string, value: T): void {
      if (entries.size >= maxEntries) sweep()
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      entries.set(key, { value, expiresAt: now() + ttlMs })
    },

    /** The entry for `key` if it has not expired; removed either way. */
    take(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      return entry.expiresAt > now() ? entry.value : undefined
    },
  }
}

export type PendingStore<T> = ReturnType<typeof createPendingStore<T>>
