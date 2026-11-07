import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { GITHUB_WEBHOOK_PATH, RUNNER_CALLBACK_PATH, type HealthResponse } from '@hinomi/shared'
import { Hono } from 'hono'
import type { AccessOptions } from './access/index.js'
import { errorBody, errorHandler } from './api/http.js'
import { registerApiRoutes, type ApiOptions } from './api/index.js'
import { accessRoutes } from './api/routes/access.js'
import { silentLogger, type Logger } from './log.js'
import type { GithubWebhookReceiver, RunnerCallbackReceiver } from './webhook/index.js'

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

  // The webhook first: GitHub's payloads outgrow the API's body limit, and the receiver reads
  // and caps the raw body itself before checking its signature.
  const webhook = apiOptions?.githubWebhook
  if (webhook) app.post(GITHUB_WEBHOOK_PATH, (c) => webhook.handle(c.req.raw))
  // The webhook runner's callback, for the same reasons: results outgrow the body limit.
  const callback = apiOptions?.webhookRunner?.receiver
  if (callback) app.post(RUNNER_CALLBACK_PATH, (c) => callback.handle(c.req.raw))

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

/**
 * The app behind HINOMI_WEBHOOK_PORT: the GitHub webhook path, the webhook runner callback and
 * nothing else, so a tunnel or funnel pointed at this port cannot reach the UI or the API even
 * when its path rule is wrong.
 */
export function createWebhookApp(
  receiver: GithubWebhookReceiver,
  log: Logger = silentLogger,
  callback?: RunnerCallbackReceiver,
) {
  const app = new Hono()
  app.onError(errorHandler(log))
  app.post(GITHUB_WEBHOOK_PATH, (c) => receiver.handle(c.req.raw))
  if (callback) app.post(RUNNER_CALLBACK_PATH, (c) => callback.handle(c.req.raw))
  app.all('*', (c) => c.json(errorBody('not_found', 'No such API route'), 404))
  return app
}
