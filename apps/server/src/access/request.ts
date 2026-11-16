import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/** The socket peer address, or undefined outside the Node server (app.request in tests). */
export function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined
  }
}
