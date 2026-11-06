import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HealthResponse } from '@hinomi/shared'
import { Hono } from 'hono'
import type { AccessOptions } from './access/index.js'
import { errorBody, errorHandler } from './api/http.js'
import { registerApiRoutes, type ApiOptions } from './api/index.js'
import { accessRoutes } from './api/routes/access.js'
import { silentLogger, type Logger } from './log.js'

export interface AppOptions {
  /** Directory with the built SPA. Static serving is skipped when it does not exist. */
  webDistDir?: string
  /** Storage and scheduler for the JSON API. Without it only /api/health and /api/access answer. */
  api?: ApiOptions
  log?: Logger
  /** Trusted proxies and the Cloudflare Access verifier for GET /api/access. */
  access?: AccessOptions
}

export function createApp({
  webDistDir,
  api: apiOptions,
  log = silentLogger,
  access = {},
}: AppOptions = {}) {
  const app = new Hono()
  const onError = errorHandler(apiOptions?.log ?? log)
  app.onError(onError)

  const api = new Hono()
  api.onError(onError)
  api.get('/health', (c) => c.json<HealthResponse>({ status: 'ok' }))
  api.route('/access', accessRoutes(access))
  if (apiOptions) registerApiRoutes(api, apiOptions)
  app.route('/api', api)
  // Unknown API routes answer with JSON instead of falling through to the SPA.
  app.all('/api/*', (c) => c.json(errorBody('not_found', 'No such API route'), 404))

  if (webDistDir && existsSync(webDistDir)) {
    app.use('*', serveStatic({ root: webDistDir }))
    // SPA fallback: any other GET outside /api gets index.html for client routing.
    app.get('*', serveStatic({ path: join(webDistDir, 'index.html') }))
  }

  return app
}
