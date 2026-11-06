import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HealthResponse } from '@hinomi/shared'
import { Hono } from 'hono'

export interface AppOptions {
  /** Directory with the built SPA. Static serving is skipped when it does not exist. */
  webDistDir?: string
}

export function createApp({ webDistDir }: AppOptions = {}) {
  const app = new Hono()

  const api = new Hono()
  api.get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))
  app.route('/api', api)
  // Unknown API routes answer with JSON instead of falling through to the SPA.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  if (webDistDir && existsSync(webDistDir)) {
    app.use('*', serveStatic({ root: webDistDir }))
    // SPA fallback: any other GET outside /api gets index.html for client routing.
    app.get('*', serveStatic({ path: join(webDistDir, 'index.html') }))
  }

  return app
}
