import { fixesQuerySchema, fixesResponseSchema } from '@hinomi/shared'
import { Hono } from 'hono'
import { groupFixes, listRankedFindings } from '../../scan/index.js'
import type { ApiDeps } from '../deps.js'
import { readQuery, send } from '../http.js'
import { latestPlanRefs, toFixItem } from '../serialize.js'

export function fixesRoutes(deps: ApiDeps) {
  const app = new Hono()

  app.get('/', (c) => {
    const query = readQuery(c, fixesQuerySchema)
    const fixes = groupFixes(listRankedFindings(deps.repositories), query)
    const page = fixes.slice(query.offset, query.offset + query.limit)
    const end = query.offset + page.length
    const planOf = latestPlanRefs(deps.repositories)
    return send(c, fixesResponseSchema, {
      items: page.map((fix) => toFixItem(fix, planOf)),
      total: fixes.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: end < fixes.length ? end : null,
    })
  })

  return app
}
