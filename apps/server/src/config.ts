import { fileURLToPath } from 'node:url'

export interface Config {
  host: string
  port: number
  webDistDir: string
}

const DEFAULT_PORT = 3000

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${value}"`)
  }
  return port
}

// The built server lives in apps/server/dist and the SPA in apps/web/dist,
// both locally and in the image, so the default is relative to this file.
const defaultWebDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url))

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '0.0.0.0',
    port: parsePort(env.PORT),
    webDistDir: env.WEB_DIST_DIR || defaultWebDistDir,
  }
}
