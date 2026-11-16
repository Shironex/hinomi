import { accessStatusSchema } from '@hinomi/shared'
import { Hono } from 'hono'
import { detectAccess, remoteAddress, type AccessOptions } from '../../access/index.js'
import { send } from '../http.js'

export function accessRoutes(options: AccessOptions) {
  const app = new Hono()

  app.get('/', async (c) => {
    const status = await detectAccess(
      { remoteAddress: remoteAddress(c), header: (name) => c.req.header(name) },
      options,
    )
    // Per request and per client: never cache it in a shared proxy.
    c.header('cache-control', 'no-store')
    return send(c, accessStatusSchema, status)
  })

  return app
}
