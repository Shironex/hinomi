import { and, desc, lt, lte } from 'drizzle-orm'
import type { AuditAction } from '@hinomi/shared'
import type { Db } from '../db/client.js'
import { auditEvents, type AuditEventRow } from '../db/schema.js'
import { currentTime } from '@hinomi/shared'

/** The log keeps this many rows; older ones are removed as new ones come in. */
export const AUDIT_KEEP_ROWS = 10_000
/** How often (in inserts) the oldest rows are trimmed. */
const TRIM_EVERY = 100

export interface AuditInput {
  action: AuditAction
  actor?: string | null
  ip?: string | null
  method?: string | null
  path?: string | null
  status?: number | null
  /** A short reason or the login method. Never a secret, a token or a request body. */
  detail?: string | null
}

export type AuditRepository = ReturnType<typeof createAuditRepository>

/** The audit log: logins, logouts, passkeys, sessions and every change through the API. */
export function createAuditRepository(db: Db) {
  return {
    record(input: AuditInput, at: Date = currentTime()): AuditEventRow {
      const row = db
        .insert(auditEvents)
        .values({
          at,
          action: input.action,
          actor: input.actor ?? null,
          ip: input.ip ?? null,
          method: input.method ?? null,
          path: input.path?.slice(0, 500) ?? null,
          status: input.status ?? null,
          detail: input.detail?.slice(0, 500) ?? null,
        })
        .returning()
        .get()
      if (row.id % TRIM_EVERY === 0) {
        db.delete(auditEvents)
          .where(lte(auditEvents.id, row.id - AUDIT_KEEP_ROWS))
          .run()
      }
      return row
    },

    /** Newest first; `before` is an id from the previous page. */
    list({ before, limit }: { before?: number | undefined; limit: number }): AuditEventRow[] {
      return db
        .select()
        .from(auditEvents)
        .where(and(before === undefined ? undefined : lt(auditEvents.id, before)))
        .orderBy(desc(auditEvents.id))
        .limit(limit)
        .all()
    },
  }
}
