import { supportStatusSchema } from '@hinomi/shared'
import { Hono } from 'hono'
import type { ApiDeps } from '../deps.js'
import { send } from '../http.js'

export function supportRoutes(deps: ApiDeps) {
  const app = new Hono()

  /** The endoflife.date cache: when it was fetched, how old it is, where the data came from. */
  app.get('/status', (c) => send(c, supportStatusSchema, deps.support.status()))

  return app
}
