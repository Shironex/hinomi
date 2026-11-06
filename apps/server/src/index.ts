import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { openStorage } from './storage.js'

const config = loadConfig()
const storage = openStorage(config)
console.log(`database ready at ${config.databaseFile}`)
if (!storage.secretBox) {
  console.warn('HINOMI_SECRET_KEY is not set: sources cannot be connected until it is')
}

const app = createApp({ webDistDir: config.webDistDir })

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`hinomi listening on http://${info.address}:${info.port}`)
})

function shutdown(signal: NodeJS.Signals) {
  console.log(`received ${signal}, shutting down`)
  server.close((error) => {
    storage.close()
    if (error) {
      console.error(error)
      process.exit(1)
    }
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
