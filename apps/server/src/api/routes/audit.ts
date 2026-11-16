import { auditQuerySchema, auditResponseSchema } from '@hinomi/shared'
import { Hono } from 'hono'
import type { ApiDeps } from '../deps.js'
import { readQuery, send } from '../http.js'

/** GET /api/audit: the audit log, newest first. */
export function auditRoutes(deps: Pick<ApiDeps, 'repositories'>) {
  const app = new Hono()

  app.get('/', (c) => {
    const { before, limit } = readQuery(c, auditQuerySchema)
    const rows = deps.repositories.audit.list({ before, limit: limit + 1 })
    const page = rows.slice(0, limit)
    return send(c, auditResponseSchema, {
      events: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        actor: row.actor,
        ip: row.ip,
        httpMethod: row.method,
        path: row.path,
        status: row.status,
        detail: row.detail,
      })),
      nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    })
  })

  return app
}
