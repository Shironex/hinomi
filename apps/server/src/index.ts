import { serve } from '@hono/node-server'
import { createCfAccessVerifier, createIpMatcher } from './access/index.js'
import { createApp, createWebhookApp } from './app.js'
import { loadConfig } from './config.js'
import { createConsoleLogger } from './log.js'
import { createNotifier, readNotifySettings } from './notify/index.js'
import {
  cachedRunnerGithub,
  createFixRunTracker,
  createRunnerCallbackHandler,
  LocalRunner,
} from './runner/index.js'
import {
  connectNotifier,
  createScheduler,
  startDigestTimer,
  startFixRunTracking,
  type DigestTimer,
  type FixRunTrackingTimer,
} from './scheduler/index.js'
import { openStorage } from './storage.js'
import {
  createGithubWebhookReceiver,
  createRunnerCallbackReceiver,
  createWebhookRunnerTransport,
} from './webhook/index.js'
import { currentTime } from '@hinomi/shared'

const log = createConsoleLogger()
const config = loadConfig()
const storage = openStorage(config)
log.info('database ready', { file: config.databaseFile })
if (!storage.secretBox) {
  log.warn('HINOMI_SECRET_KEY is not set: sources cannot be connected until it is')
}
log.warn(
  'Hinomi has no login yet: run it behind Tailscale or Cloudflare Access and never expose the port to the internet',
)
if (config.trustedProxies.length > 0) {
  log.info('access: trusting forwarded headers', { proxies: config.trustedProxies })
}
if (config.cfAccess)
  log.info('access: verifying Cloudflare Access tokens', {
    teamDomain: config.cfAccess.teamDomain,
  })

const scheduler = createScheduler({
  repositories: storage.repositories,
  log,
  shutdownTimeoutMs: config.shutdownTimeoutMs,
})
const notifier = createNotifier({
  repositories: storage.repositories,
  secretBox: storage.secretBox,
  log,
})
connectNotifier(scheduler, notifier)
// Fix run changes (a PR opened, checks failing, verified, failed, ...) go to the same channels.
storage.repositories.fixRuns.onChanged((run) => void notifier.handleFixRunChanged(run))
let digest: DigestTimer | null = null
const tracker = createFixRunTracker({
  repositories: storage.repositories,
  log,
  publicBaseUrl: () => readNotifySettings(storage.repositories.settings).publicBaseUrl,
  // Verification rescans go through the scheduler, so they never run beside a full scan.
  rescan: async (repoId) => {
    const pending = scheduler.scanRepo(repoId)
    if (!pending) return { kind: 'busy' }
    const summary = await pending
    if (summary.status === 'failed') {
      return { kind: 'failed', error: summary.errors[0]?.error ?? 'the rescan failed' }
    }
    return { kind: 'done', at: summary.finishedAt, changes: summary.changes }
  },
})
// A full scan verifies the fix runs that wait for one (the fallback when rescans keep failing).
scheduler.onScanFinished((summary) => {
  tracker.scanFinished({
    scanRunId: summary.scanRunId,
    status: summary.status,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    failedRepos: summary.errors.map((e) => e.subject),
    changes: summary.changes,
  })
})
let tracking: FixRunTrackingTimer | null = null
// The optional GitHub webhook only brings polls forward; the tracker's own poll moves the runs.
const githubWebhook = createGithubWebhookReceiver({
  repositories: storage.repositories,
  secretBox: storage.secretBox,
  log,
  dedicatedPort: config.webhookPort,
  pollNow: (select) => {
    const ids = tracker.pollNow(select)
    if (ids.length > 0) tracking?.wake()
    return ids
  },
})

// The webhook runner: plans go out through the transport (signed, address guarded), results come
// back on the callback path and move the run like a poll would.
const runnerCallback = createRunnerCallbackReceiver({
  repositories: storage.repositories,
  secretBox: storage.secretBox,
  log,
  dedicatedPort: config.webhookPort,
  handle: createRunnerCallbackHandler({
    repositories: storage.repositories,
    github: cachedRunnerGithub(storage.repositories),
    now: currentTime,
    pollNow: (runId) => {
      if (tracker.pollNow((run) => run.id === runId).length > 0) tracking?.wake()
    },
  }),
})
const webhookRunner = {
  receiver: runnerCallback,
  transport: createWebhookRunnerTransport({ settings: runnerCallback.settings }),
}

// The local runner: off unless HINOMI_LOCAL_RUNNER=1. Leftovers of a run a restart cut short are
// removed and their runs failed before anything can dispatch.
const localRunner = new LocalRunner({
  repositories: storage.repositories,
  github: cachedRunnerGithub(storage.repositories),
  enabled: config.localRunner.enabled,
  checks: config.localRunner.checks,
  dataDir: config.dataDir,
  actionEntry: config.localRunner.entry,
  hostPath: config.localRunner.path,
  log,
  onBranchPushed: (runId) => {
    if (tracker.pollNow((run) => run.id === runId).length > 0) tracking?.wake()
  },
})
const interrupted = await localRunner.recover()
if (interrupted > 0) log.warn('local runner: failed runs a restart cut short', { interrupted })
if (config.localRunner.enabled) {
  const local = localRunner.availability()
  log.warn('local runner: enabled, fix plans run on this host', {
    available: local.available,
    message: local.message,
    checks: config.localRunner.checks,
  })
}

const app = createApp({
  webDistDir: config.webDistDir,
  api: {
    repositories: storage.repositories,
    scheduler,
    log,
    notifications: { notifier, onDigestHourChanged: () => digest?.rearm() },
    fixRunTracking: tracker,
    githubWebhook,
    webhookRunner,
    localRunner,
  },
  access: {
    ...(config.trustedProxies.length > 0 && {
      isTrustedProxy: createIpMatcher(config.trustedProxies),
    }),
    ...(config.cfAccess && { cfAccess: createCfAccessVerifier(config.cfAccess) }),
  },
  log,
})

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info('hinomi listening', { url: `http://${info.address}:${info.port}` })
  scheduler.start()
  digest = startDigestTimer({ notifier, settings: storage.repositories.settings, log })
  log.info('notify: daily digest planned', { at: digest.nextAt()?.toISOString() ?? null })
  tracking = startFixRunTracking({ ticker: tracker, log })
})

// HINOMI_WEBHOOK_PORT: a listener with the webhook path alone, the one port safe to expose.
const webhookServer =
  config.webhookPort === null
    ? null
    : serve(
        {
          fetch: createWebhookApp(githubWebhook, log, runnerCallback).fetch,
          hostname: config.host,
          port: config.webhookPort,
        },
        (info) => {
          log.info('webhooks listening (webhook paths only)', {
            url: `http://${info.address}:${info.port}`,
          })
        },
      )

let shuttingDown = false

/**
 * Stops new work, waits for a running scan (HINOMI_SHUTDOWN_TIMEOUT_SECONDS), then
 * closes the HTTP server and storage. A second signal exits at once.
 */
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    log.warn('received a second signal, exiting now', { signal })
    process.exit(1)
  }
  shuttingDown = true
  log.info('shutting down', { signal })
  digest?.stop()
  tracking?.stop()
  const { drained } = await scheduler.shutdown()
  // A tick in flight is a handful of GitHub requests, each with its own timeout.
  await Promise.race([
    tracking?.idle(),
    new Promise((resolve) => setTimeout(resolve, config.shutdownTimeoutMs).unref()),
  ])
  if (drained) log.info('scheduler: no scan running, closing')
  // A local run in progress is stopped; it fails with the reason and its folder is removed.
  await localRunner.close()
  webhookServer?.close()
  server.close((error) => {
    storage.close()
    if (error) {
      log.error('server close failed', { error: error.message })
      process.exit(1)
    }
    process.exit(0)
  })
}

process.on('SIGINT', (signal) => void shutdown(signal))
process.on('SIGTERM', (signal) => void shutdown(signal))
