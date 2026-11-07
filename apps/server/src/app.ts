import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
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

/** Files that must always be revalidated so a new build, and its service worker, is seen at once. */
const REVALIDATED = new Set(['index.html', 'sw.js', 'manifest.webmanifest'])

function cacheControlFor(path: string): string | undefined {
  if (path === '/' || REVALIDATED.has(basename(path))) return 'no-cache'
  // Vite names these by content hash, so they never change under the same name.
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return undefined
}

function looksLikeFile(path: string): boolean {
  return basename(path).includes('.')
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
    app.use('*', async (c, next) => {
      await next()
      // Only a file that was served; the SPA fallback below keeps index.html revalidated too.
      const cache = c.res.ok ? cacheControlFor(c.req.path) : undefined
      if (cache) c.header('Cache-Control', cache)
    })
    app.use('*', serveStatic({ root: webDistDir }))
    // SPA fallback: any other GET outside /api gets index.html for client routing. A path that
    // names a file (a stale hashed asset, a missing icon) is a real 404, never HTML in its place.
    app.get('*', async (c, next) => {
      if (looksLikeFile(c.req.path)) return c.notFound()
      return next()
    })
    app.get('*', async (c, next) => {
      await next()
      if (c.res.ok) c.header('Cache-Control', 'no-cache')
    })
    app.get('*', serveStatic({ path: join(webDistDir, 'index.html') }))
  }

  return app
}
