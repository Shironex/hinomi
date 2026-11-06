import { getConnInfo } from '@hono/node-server/conninfo'
import { accessStatusSchema } from '@hinomi/shared'
import { Hono, type Context } from 'hono'
import { detectAccess, type AccessOptions } from '../../access/index.js'
import { send } from '../http.js'

/** The socket peer address, or undefined outside the Node server (app.request in tests). */
function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined
  }
}

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
