import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export interface Config {
  host: string
  port: number
  webDistDir: string
  /** Directory that holds the SQLite database. Created on boot when missing. */
  dataDir: string
  /** Full path of the SQLite database file inside dataDir. */
  databaseFile: string
  /** Folder with the drizzle-kit generated SQL migrations. */
  migrationsDir: string
  /**
   * Secret used to derive the token encryption key. Optional: without it the
   * app runs, but source tokens cannot be stored or read.
   */
  secretKey: string | undefined
  /** How long shutdown waits for a running scan before it is marked interrupted. */
  shutdownTimeoutMs: number
}

const DEFAULT_PORT = 3000
export const DATABASE_FILENAME = 'hinomi.db'
export const MIN_SECRET_KEY_LENGTH = 16
/**
 * How long shutdown waits for a running scan by default. Below the 30 s stop grace of
 * docker-compose.yml, so the process closes storage itself before Docker sends SIGKILL.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 25
const MAX_SHUTDOWN_TIMEOUT_SECONDS = 3600

// The built server lives in apps/server/dist and the SPA in apps/web/dist,
// both locally and in the image. In dev this file runs from apps/server/src,
// so paths relative to it resolve to the same places either way.
const defaultWebDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url))
const defaultMigrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Treat an empty value (`FOO=` in an env file) the same as an unset one. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value))

const envSchema = z.object({
  HOST: optionalString.transform((value) => value ?? '0.0.0.0'),
  PORT: optionalString.transform((value, ctx) => {
    if (value === undefined) return DEFAULT_PORT
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.addIssue({
        code: 'custom',
        message: `PORT must be an integer between 1 and 65535, got "${value}"`,
      })
      return z.NEVER
    }
    return port
  }),
  WEB_DIST_DIR: optionalString,
  NODE_ENV: optionalString,
  HINOMI_DATA_DIR: optionalString,
  HINOMI_SHUTDOWN_TIMEOUT_SECONDS: optionalString.transform((value, ctx) => {
    if (value === undefined) return DEFAULT_SHUTDOWN_TIMEOUT_SECONDS
    const seconds = Number(value)
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SHUTDOWN_TIMEOUT_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        message: `HINOMI_SHUTDOWN_TIMEOUT_SECONDS must be a whole number of seconds between 0 and ${MAX_SHUTDOWN_TIMEOUT_SECONDS}, got "${value}"`,
      })
      return z.NEVER
    }
    return seconds
  }),
  HINOMI_SECRET_KEY: optionalString.pipe(
    z
      .string()
      .min(
        MIN_SECRET_KEY_LENGTH,
        `HINOMI_SECRET_KEY must be at least ${MIN_SECRET_KEY_LENGTH} characters (try: openssl rand -base64 32)`,
      )
      .optional(),
  ),
})

/** Default data dir: `/data` in production (the container volume), `./data` in dev. */
function defaultDataDir(nodeEnv: string | undefined): string {
  return nodeEnv === 'production' ? '/data' : resolve('data')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env)
  if (!result.success) {
    // Only issue messages are shown, never the received values: one of them
    // may be the secret key.
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid configuration: ${details}`)
  }
  const parsed = result.data
  const dataDir = resolve(parsed.HINOMI_DATA_DIR ?? defaultDataDir(parsed.NODE_ENV))

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    webDistDir: parsed.WEB_DIST_DIR ?? defaultWebDistDir,
    dataDir,
    databaseFile: resolve(dataDir, DATABASE_FILENAME),
    migrationsDir: defaultMigrationsDir,
    secretKey: parsed.HINOMI_SECRET_KEY,
    shutdownTimeoutMs: parsed.HINOMI_SHUTDOWN_TIMEOUT_SECONDS * 1000,
  }
}
