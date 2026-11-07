import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { silentLogger, type Logger } from '../log.js'
import { readNotifySettings } from '../notify/index.js'
import type { Repositories } from '../repository/index.js'
import {
  createFixRunService,
  type FixRunService,
  type FixRunServiceOptions,
  type FixRunTracker,
} from '../runner/index.js'
import type { Scheduler } from '../scheduler/index.js'
import type {
  GithubWebhookReceiver,
  RunnerCallbackReceiver,
  WebhookRunnerTransport,
} from '../webhook/index.js'
import type { UpdateChecker } from '../version/index.js'
import type { ApiDeps } from './deps.js'
import { errorBody } from './http.js'
import { deploymentsRoutes, plansRoutes, reposRoutes } from './routes/deployments.js'
import { findingsRoutes } from './routes/findings.js'
import { fixRunsRoutes, repoFixRunsRoutes } from './routes/fix-runs.js'
import { fixesRoutes } from './routes/fixes.js'
import { githubWebhookSettingsRoutes } from './routes/github-webhook.js'
import { webhookRunnerSettingsRoutes } from './routes/webhook-runner.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { notificationsRoutes, type NotificationsApiOptions } from './routes/notifications.js'
import { repoDetailRoutes } from './routes/repos.js'
import { sourcesRoutes } from './routes/sources.js'
import { overviewRoutes, scansRoutes, settingsRoutes, shellRoutes } from './routes/system.js'
import { createSourceTesters, type SourceTesters } from './source-testers.js'
import { currentTime } from '@hinomi/shared'

/** Largest JSON body the API reads. Every request is small; this only stops abuse. */
export const MAX_BODY_BYTES = 64 * 1024

export interface ApiOptions {
  repositories: Repositories
  scheduler: Scheduler
  testers?: SourceTesters
  log?: Logger
  now?: () => Date
  /** Fetch for live reads from a source (deploy history). Defaults to the global fetch. */
  sourceFetch?: typeof fetch
  /** Notification channels and settings. Without it those routes are not registered. */
  notifications?: NotificationsApiOptions
  /** Runner settings and fix run dispatch. Defaults to the GitHub Actions runner on `sourceFetch`. */
  fixRuns?: FixRunService
  /** The daily update check, looked at again when the Settings switch is turned on. */
  updates?: Pick<UpdateChecker, 'check'>
  /** The fix run tracker, for the tracking state on GET /api/fix-runs/:id. */
  fixRunTracking?: Pick<FixRunTracker, 'status'>
  /**
   * The optional GitHub webhook. Registers its settings routes here; createApp mounts the
   * receiver itself outside the API's body limit.
   */
  githubWebhook?: GithubWebhookReceiver
  /**
   * The webhook runner: its settings routes, and the transport repos of the webhook kind post
   * their plans through. createApp mounts the callback receiver itself.
   */
  webhookRunner?: { receiver: RunnerCallbackReceiver; transport: WebhookRunnerTransport }
  /** The local runner (HINOMI_LOCAL_RUNNER), for repos of the local kind. */
  localRunner?: FixRunServiceOptions['localRunner']
}

/**
 * Registers the JSON API routes on `api` (mounted at /api). Every request and
 * response is checked against the zod contract in packages/shared/src/api.ts.
 */
export function registerApiRoutes(api: Hono, options: ApiOptions): void {
  const now = options.now ?? currentTime
  const deps: ApiDeps = {
    repositories: options.repositories,
    scheduler: options.scheduler,
    testers: options.testers ?? createSourceTesters(),
    log: options.log ?? silentLogger,
    now,
    ...(options.sourceFetch && { sourceFetch: options.sourceFetch }),
    ...(options.fixRunTracking && { fixRunTracking: options.fixRunTracking }),
    ...(options.updates && { updates: options.updates }),
    fixRuns:
      options.fixRuns ??
      createFixRunService({
        repositories: options.repositories,
        now,
        publicBaseUrl: () => readNotifySettings(options.repositories.settings).publicBaseUrl,
        ...(options.sourceFetch && { fetch: options.sourceFetch }),
        ...(options.webhookRunner && { webhookDelivery: options.webhookRunner.transport }),
        ...(options.localRunner && { localRunner: options.localRunner }),
      }),
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
  api.route('/fixes', fixesRoutes(deps))
  api.route('/deployments', deploymentsRoutes(deps))
  api.route('/repos', reposRoutes(deps))
  api.route('/repos', repoFixRunsRoutes(deps))
  api.route('/repos', repoDetailRoutes(deps))
  api.route('/fix-runs', fixRunsRoutes(deps))
  api.route('/plans', plansRoutes(deps))
  api.route('/sources', sourcesRoutes(deps))
  if (options.githubWebhook) {
    api.route('/settings/github-webhook', githubWebhookSettingsRoutes(deps, options.githubWebhook))
  }
  if (options.webhookRunner) {
    api.route(
      '/settings/webhook-runner',
      webhookRunnerSettingsRoutes(deps, options.webhookRunner.receiver),
    )
  }
  api.route('/settings', settingsRoutes(deps))
  api.route('/scans', scansRoutes(deps))
  api.route('/shell', shellRoutes(deps))
  api.route('/onboarding', onboardingRoutes(deps))
  if (options.notifications) {
    api.route('/notifications', notificationsRoutes(deps, options.notifications))
  }
}
