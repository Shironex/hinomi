import { serve } from '@hono/node-server'
import { createCfAccessVerifier, createIpMatcher } from './access/index.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createConsoleLogger } from './log.js'
import { createNotifier } from './notify/index.js'
import {
  connectNotifier,
  createScheduler,
  startDigestTimer,
  type DigestTimer,
} from './scheduler/index.js'
import { openStorage } from './storage.js'

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
let digest: DigestTimer | null = null

const app = createApp({
  webDistDir: config.webDistDir,
  api: {
    repositories: storage.repositories,
    scheduler,
    log,
    notifications: { notifier, onDigestHourChanged: () => digest?.rearm() },
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
})

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
  const { drained } = await scheduler.shutdown()
  if (drained) log.info('scheduler: no scan running, closing')
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
