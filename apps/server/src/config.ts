import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readBuildInfo, type BuildInfo } from './version/build-info.js'
import { createIpMatcher, InvalidCidrError, normalizeTeamDomain } from './access/index.js'
import { InvalidAllowRuleError, parseAllowRules, type AllowRule } from './auth/index.js'

/** The built in login (HINOMI_AUTH=1, docs/auth.md). */
export interface AuthConfig {
  /** HINOMI_AUTH_PUBLIC_URL as an origin: the only origin changes and passkeys are accepted from. */
  publicOrigin: string
  /** The origin is https, so cookies carry Secure and the __Host- prefix. */
  secure: boolean
  /** The WebAuthn relying party id: the host name of the public URL. */
  rpId: string
  oidc: {
    issuer: string
    clientId: string
    clientSecret: string
    name: string
    /** HINOMI_AUTH_OIDC_TOKEN_ORIGIN: another origin the token endpoint may be on, or null. */
    tokenOrigin: string | null
  } | null
  github: { clientId: string; clientSecret: string } | null
  /** HINOMI_AUTH_ALLOWED, for OpenID Connect and GitHub sign in. */
  allowed: AllowRule[]
}

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
  /**
   * Proxies (IPs or CIDR ranges) whose forwarded headers are believed when the access
   * state is worked out. Empty: every forwarded header is ignored.
   */
  trustedProxies: string[]
  /** Team domain (https origin) and audience to verify Cloudflare Access tokens; null when unset. */
  cfAccess: { teamDomain: string; audience: string } | null
  /**
   * HINOMI_WEBHOOK_PORT: a second listener that serves only the GitHub webhook path, so a
   * tunnel pointed at it can reach nothing else. Null when unset.
   */
  webhookPort: number | null
  /**
   * HINOMI_LOCAL_RUNNER=1 allows the local runner (fix plans applied on this host);
   * HINOMI_LOCAL_RUNNER_CHECKS=1 also runs install scripts and checks there. `entry` is the
   * bundled fix runner action it spawns, `path` the PATH its children get.
   */
  localRunner: { enabled: boolean; checks: boolean; entry: string; path: string }
  /** The running build, from the Docker build args (HINOMI_BUILD_VERSION, _COMMIT, _DATE). */
  build: BuildInfo
  /** The built in login; null while HINOMI_AUTH is off (the default). */
  auth: AuthConfig | null
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
// The action bundle sits at the repo root in dev and at /app/actions in the image.
const defaultFixRunnerEntry = fileURLToPath(
  new URL('../../../actions/fix-runner/dist/index.mjs', import.meta.url),
)

/** Treat an empty value (`FOO=` in an env file) the same as an unset one. */
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value))

/** An on or off switch: 1, true or yes; 0, false, no or unset. */
function flagSetting(name: string) {
  return optionalString.transform((value, ctx) => {
    const text = (value ?? '').trim().toLowerCase()
    if (['', '0', 'false', 'no'].includes(text)) return false
    if (['1', 'true', 'yes'].includes(text)) return true
    ctx.addIssue({ code: 'custom', message: `${name} must be 1 or 0, got "${value ?? ''}"` })
    return z.NEVER
  })
}

/** A TCP port, or undefined when unset. */
function portSetting(name: string) {
  return optionalString.transform((value, ctx) => {
    if (value === undefined) return undefined
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be an integer between 1 and 65535, got "${value}"`,
      })
      return z.NEVER
    }
    return port
  })
}

const envSchema = z.object({
  HOST: optionalString.transform((value) => value ?? '0.0.0.0'),
  PORT: portSetting('PORT').transform((port) => port ?? DEFAULT_PORT),
  HINOMI_WEBHOOK_PORT: portSetting('HINOMI_WEBHOOK_PORT'),
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
  HINOMI_TRUSTED_PROXIES: optionalString.transform((value, ctx) => {
    const entries = (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    try {
      createIpMatcher(entries)
    } catch (error) {
      if (!(error instanceof InvalidCidrError)) throw error
      ctx.addIssue({ code: 'custom', message: `HINOMI_TRUSTED_PROXIES: ${error.message}` })
      return z.NEVER
    }
    return entries
  }),
  HINOMI_CF_ACCESS_TEAM_DOMAIN: optionalString.transform((value, ctx) => {
    if (value === undefined) return undefined
    const origin = normalizeTeamDomain(value)
    if (!origin) {
      ctx.addIssue({
        code: 'custom',
        message: `HINOMI_CF_ACCESS_TEAM_DOMAIN must be a team name or an https team domain like https://<team>.cloudflareaccess.com, got "${value}"`,
      })
      return z.NEVER
    }
    return origin
  }),
  HINOMI_CF_ACCESS_AUD: optionalString,
  HINOMI_AUTH: flagSetting('HINOMI_AUTH'),
  HINOMI_AUTH_ALLOW_HTTP: flagSetting('HINOMI_AUTH_ALLOW_HTTP'),
  HINOMI_AUTH_PUBLIC_URL: optionalString.transform((value, ctx) => {
    if (value === undefined) return undefined
    const origin = parsePublicOrigin(value)
    if (!origin) {
      ctx.addIssue({
        code: 'custom',
        message: `HINOMI_AUTH_PUBLIC_URL must be the address people open, like https://hinomi.example.dev (no path), got "${value}"`,
      })
      return z.NEVER
    }
    return origin
  }),
  HINOMI_AUTH_OIDC_ISSUER: optionalString.transform((value, ctx) => {
    if (value === undefined) return undefined
    const issuer = parseIssuer(value)
    if (!issuer) {
      ctx.addIssue({
        code: 'custom',
        message: `HINOMI_AUTH_OIDC_ISSUER must be the provider's https issuer URL, got "${value}"`,
      })
      return z.NEVER
    }
    return issuer
  }),
  HINOMI_AUTH_OIDC_CLIENT_ID: optionalString,
  HINOMI_AUTH_OIDC_CLIENT_SECRET: optionalString,
  HINOMI_AUTH_OIDC_NAME: optionalString,
  HINOMI_AUTH_OIDC_TOKEN_ORIGIN: optionalString.transform((value, ctx) => {
    if (value === undefined) return undefined
    const origin = parsePublicOrigin(value)
    if (!origin?.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        message: `HINOMI_AUTH_OIDC_TOKEN_ORIGIN must be an https origin without a path, like https://oauth2.googleapis.com, got "${value}"`,
      })
      return z.NEVER
    }
    return origin
  }),
  HINOMI_AUTH_GITHUB_CLIENT_ID: optionalString,
  HINOMI_AUTH_GITHUB_CLIENT_SECRET: optionalString,
  HINOMI_AUTH_ALLOWED: optionalString.transform((value, ctx) => {
    try {
      return parseAllowRules(value)
    } catch (error) {
      if (!(error instanceof InvalidAllowRuleError)) throw error
      ctx.addIssue({ code: 'custom', message: `HINOMI_AUTH_ALLOWED: ${error.message}` })
      return z.NEVER
    }
  }),
  HINOMI_LOCAL_RUNNER: flagSetting('HINOMI_LOCAL_RUNNER'),
  HINOMI_LOCAL_RUNNER_CHECKS: flagSetting('HINOMI_LOCAL_RUNNER_CHECKS'),
  PATH: optionalString,
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

const isLocalHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

/** An http(s) origin without path, query or credentials, or null. */
function parsePublicOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

/** An https issuer URL (http only on this machine, for a local provider), without a trailing slash. */
function parseIssuer(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.search || url.hash || url.username || url.password) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
      return null
    }
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

type ParsedEnv = z.output<typeof envSchema>

function loadAuthConfig(parsed: ParsedEnv, env: NodeJS.ProcessEnv): AuthConfig | null {
  const oidcValues = [
    parsed.HINOMI_AUTH_OIDC_ISSUER,
    parsed.HINOMI_AUTH_OIDC_CLIENT_ID,
    parsed.HINOMI_AUTH_OIDC_CLIENT_SECRET,
  ]
  const oidcSet = oidcValues.filter((value) => value !== undefined).length
  // A half configured provider is a startup error, never a silent skip.
  if (oidcSet !== 0 && oidcSet !== oidcValues.length) {
    throw new Error(
      'Invalid configuration: set HINOMI_AUTH_OIDC_ISSUER, HINOMI_AUTH_OIDC_CLIENT_ID and HINOMI_AUTH_OIDC_CLIENT_SECRET together, or none of them',
    )
  }
  if (
    (parsed.HINOMI_AUTH_GITHUB_CLIENT_ID === undefined) !==
    (parsed.HINOMI_AUTH_GITHUB_CLIENT_SECRET === undefined)
  ) {
    throw new Error(
      'Invalid configuration: set HINOMI_AUTH_GITHUB_CLIENT_ID and HINOMI_AUTH_GITHUB_CLIENT_SECRET together, or neither',
    )
  }
  if (!parsed.HINOMI_AUTH) {
    // Login settings without the switch look like a protected install that is not: refuse to
    // start, unless the login was turned off on purpose with HINOMI_AUTH=0.
    const explicitOff = ['0', 'false', 'no'].includes((env.HINOMI_AUTH ?? '').trim().toLowerCase())
    const stray = Object.keys(env)
      .filter((key) => key.startsWith('HINOMI_AUTH_') && (env[key] ?? '').trim() !== '')
      .sort()
    if (stray.length > 0 && !explicitOff) {
      throw new Error(
        `Invalid configuration: ${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} set but HINOMI_AUTH is not, so the login would be off. Set HINOMI_AUTH=1 to turn it on, or HINOMI_AUTH=0 to keep it off on purpose`,
      )
    }
    return null
  }

  const origin = parsed.HINOMI_AUTH_PUBLIC_URL
  if (!origin) {
    throw new Error(
      'Invalid configuration: HINOMI_AUTH=1 needs HINOMI_AUTH_PUBLIC_URL, the address people open Hinomi at (for example https://hinomi.example.dev)',
    )
  }
  const publicUrl = new URL(origin)
  if (
    publicUrl.protocol === 'http:' &&
    !isLocalHost(publicUrl.hostname) &&
    !parsed.HINOMI_AUTH_ALLOW_HTTP
  ) {
    throw new Error(
      'Invalid configuration: HINOMI_AUTH_PUBLIC_URL is http on a host other than localhost, so the session cookie would cross the network in the clear. Use https, or set HINOMI_AUTH_ALLOW_HTTP=1 to accept that',
    )
  }
  const oidc =
    parsed.HINOMI_AUTH_OIDC_ISSUER &&
    parsed.HINOMI_AUTH_OIDC_CLIENT_ID &&
    parsed.HINOMI_AUTH_OIDC_CLIENT_SECRET
      ? {
          issuer: parsed.HINOMI_AUTH_OIDC_ISSUER,
          clientId: parsed.HINOMI_AUTH_OIDC_CLIENT_ID,
          clientSecret: parsed.HINOMI_AUTH_OIDC_CLIENT_SECRET,
          name: parsed.HINOMI_AUTH_OIDC_NAME?.trim() ?? 'single sign on',
          tokenOrigin: parsed.HINOMI_AUTH_OIDC_TOKEN_ORIGIN ?? null,
        }
      : null
  const github =
    parsed.HINOMI_AUTH_GITHUB_CLIENT_ID && parsed.HINOMI_AUTH_GITHUB_CLIENT_SECRET
      ? {
          clientId: parsed.HINOMI_AUTH_GITHUB_CLIENT_ID,
          clientSecret: parsed.HINOMI_AUTH_GITHUB_CLIENT_SECRET,
        }
      : null
  if ((oidc || github) && parsed.HINOMI_AUTH_ALLOWED.length === 0) {
    throw new Error(
      'Invalid configuration: OpenID Connect or GitHub sign in needs HINOMI_AUTH_ALLOWED (emails, @domains, github:id:<number>, github:<login> or oidc:<subject>), or anyone with an account there could sign in',
    )
  }
  return {
    publicOrigin: origin,
    secure: publicUrl.protocol === 'https:',
    rpId: publicUrl.hostname,
    oidc,
    github,
    allowed: parsed.HINOMI_AUTH_ALLOWED,
  }
}

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
  if (
    (parsed.HINOMI_CF_ACCESS_TEAM_DOMAIN === undefined) !==
    (parsed.HINOMI_CF_ACCESS_AUD === undefined)
  ) {
    throw new Error(
      'Invalid configuration: set both HINOMI_CF_ACCESS_TEAM_DOMAIN and HINOMI_CF_ACCESS_AUD to verify Cloudflare Access tokens, or neither',
    )
  }
  if (parsed.HINOMI_WEBHOOK_PORT === parsed.PORT) {
    throw new Error(
      'Invalid configuration: HINOMI_WEBHOOK_PORT must differ from PORT, or be left unset to serve the webhook on PORT only',
    )
  }
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
    trustedProxies: parsed.HINOMI_TRUSTED_PROXIES,
    cfAccess:
      parsed.HINOMI_CF_ACCESS_TEAM_DOMAIN && parsed.HINOMI_CF_ACCESS_AUD
        ? { teamDomain: parsed.HINOMI_CF_ACCESS_TEAM_DOMAIN, audience: parsed.HINOMI_CF_ACCESS_AUD }
        : null,
    webhookPort: parsed.HINOMI_WEBHOOK_PORT ?? null,
    localRunner: {
      enabled: parsed.HINOMI_LOCAL_RUNNER,
      checks: parsed.HINOMI_LOCAL_RUNNER_CHECKS,
      entry: defaultFixRunnerEntry,
      path: parsed.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
    build: readBuildInfo(env),
    auth: loadAuthConfig(parsed, env),
  }
}
