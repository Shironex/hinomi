import { serve } from '@hono/node-server'
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
log.info(`database ready at ${config.databaseFile}`)
if (!storage.secretBox) {
  log.warn('HINOMI_SECRET_KEY is not set: sources cannot be connected until it is')
}
log.warn(
  'Hinomi has no login yet: run it behind Tailscale or Cloudflare Access and never expose the port to the internet',
)

const scheduler = createScheduler({ repositories: storage.repositories, log })
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
  log,
})

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info(`hinomi listening on http://${info.address}:${info.port}`)
  scheduler.start()
  digest = startDigestTimer({ notifier, settings: storage.repositories.settings, log })
  log.info('notify: daily digest planned', { at: digest.nextAt()?.toISOString() ?? null })
})

function shutdown(signal: NodeJS.Signals) {
  log.info(`received ${signal}, shutting down`)
  scheduler.stop()
  digest?.stop()
  server.close((error) => {
    storage.close()
    if (error) {
      log.error('server close failed', { error: error.message })
      process.exit(1)
    }
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
