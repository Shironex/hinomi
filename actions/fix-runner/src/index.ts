import { main } from './main.js'

process.exitCode = await main({
  env: process.env,
  write: (line) => process.stdout.write(`${line}\n`),
  // The registry URL is checked in registry.ts: https, or http on a loopback host only.
  fetch: globalThis.fetch,
})
