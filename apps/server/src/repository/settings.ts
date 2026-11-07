import { asc, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { Db } from '../db/client.js'
import { settings } from '../db/schema.js'
import { currentTime } from '@hinomi/shared'

export type SettingsRepository = ReturnType<typeof createSettingsRepository>

/** Key/value settings stored as JSON. Never store secrets here: values are not encrypted. */
export function createSettingsRepository(db: Db) {
  function getRaw(key: string): unknown {
    return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value
  }

  return {
    /**
     * Reads a setting and validates it with the schema. A missing key, or a
     * stored value that no longer matches the schema, returns undefined.
     */
    get<T>(key: string, schema: z.ZodType<T>): T | undefined {
      const value = getRaw(key)
      if (value === undefined) return undefined
      const parsed = schema.safeParse(value)
      return parsed.success ? parsed.data : undefined
    },

    set(key: string, value: unknown): void {
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: currentTime() } })
        .run()
    },

    remove(key: string): boolean {
      return db.delete(settings).where(eq(settings.key, key)).run().changes > 0
    },

    /** Every setting, for an export or a settings screen. */
    all(): Record<string, unknown> {
      const rows = db.select().from(settings).orderBy(asc(settings.key)).all()
      return Object.fromEntries(rows.map((row) => [row.key, row.value]))
    },
  }
}
