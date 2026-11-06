import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const app = createApp({ webDistDir: config.webDistDir })

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`hinomi listening on http://${info.address}:${info.port}`)
})

function shutdown(signal: NodeJS.Signals) {
  console.log(`received ${signal}, shutting down`)
  server.close((error) => {
    if (error) {
      console.error(error)
      process.exit(1)
    }
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
