import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { silentLogger, type Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import type { Scheduler } from '../scheduler/index.js'
import type { ApiDeps } from './deps.js'
import { errorBody, errorHandler } from './http.js'
import { deploymentsRoutes, reposRoutes } from './routes/deployments.js'
import { findingsRoutes } from './routes/findings.js'
import { notificationsRoutes, type NotificationsApiOptions } from './routes/notifications.js'
import { sourcesRoutes } from './routes/sources.js'
import { overviewRoutes, scansRoutes, settingsRoutes, shellRoutes } from './routes/system.js'
import { createSourceTesters, type SourceTesters } from './source-testers.js'

export type { ApiDeps } from './deps.js'
export type { NotificationsApiOptions } from './routes/notifications.js'
export { createSourceTesters, type SourceTesters } from './source-testers.js'

/** Largest JSON body the API reads. Every request is small; this only stops abuse. */
export const MAX_BODY_BYTES = 64 * 1024

export interface ApiOptions {
  repositories: Repositories
  scheduler: Scheduler
  testers?: SourceTesters
  log?: Logger
  now?: () => Date
  /** Notification channels and settings. Without it those routes are not registered. */
  notifications?: NotificationsApiOptions
}

/**
 * Registers the JSON API routes on `api` (mounted at /api). Every request and
 * response is checked against the zod contract in packages/shared/src/api.ts.
 */
export function registerApiRoutes(api: Hono, options: ApiOptions): void {
  const deps: ApiDeps = {
    repositories: options.repositories,
    scheduler: options.scheduler,
    testers: options.testers ?? createSourceTesters(),
    log: options.log ?? silentLogger,
    now: options.now ?? (() => new Date()),
  }

  api.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          errorBody('payload_too_large', `The request body is larger than ${MAX_BODY_BYTES} bytes`),
          413,
        ),
    }),
  )

  api.route('/overview', overviewRoutes(deps))
  api.route('/findings', findingsRoutes(deps))
  api.route('/deployments', deploymentsRoutes(deps))
  api.route('/repos', reposRoutes(deps))
  api.route('/sources', sourcesRoutes(deps))
  api.route('/settings', settingsRoutes(deps))
  api.route('/scans', scansRoutes(deps))
  api.route('/shell', shellRoutes(deps))
  if (options.notifications) {
    api.route('/notifications', notificationsRoutes(deps, options.notifications))
  }
}

export { errorHandler }
