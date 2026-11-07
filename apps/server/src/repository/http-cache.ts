import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { httpCache, type HttpCacheRow } from '../db/schema.js'

export type HttpCacheRepository = ReturnType<typeof createHttpCacheRepository>

export interface HttpCacheEntry {
  key: string
  etag: string | null
  lastModified: string | null
  fetchedAt: Date
  status: number
  /** The stored bytes. The caller decides the encoding (the support data is gzip). */
  body: Buffer
}

function toEntry(row: HttpCacheRow): HttpCacheEntry {
  return { ...row }
}

/** Answers of public HTTP APIs kept between runs, with the validators for conditional requests. */
export function createHttpCacheRepository(db: Db) {
  return {
    get(key: string): HttpCacheEntry | null {
      const row = db.select().from(httpCache).where(eq(httpCache.key, key)).get()
      return row ? toEntry(row) : null
    },

    /** Stores a fresh answer, replacing the entry of the key. */
    put(entry: HttpCacheEntry): void {
      db.insert(httpCache)
        .values(entry)
        .onConflictDoUpdate({
          target: httpCache.key,
          set: {
            etag: entry.etag,
            lastModified: entry.lastModified,
            fetchedAt: entry.fetchedAt,
            status: entry.status,
            body: entry.body,
          },
        })
        .run()
    },

    /** The server said "not modified": the body stays, only the check time moves. */
    touch(key: string, fetchedAt: Date): boolean {
      return db.update(httpCache).set({ fetchedAt }).where(eq(httpCache.key, key)).run().changes > 0
    },

    remove(key: string): boolean {
      return db.delete(httpCache).where(eq(httpCache.key, key)).run().changes > 0
    },
  }
}
