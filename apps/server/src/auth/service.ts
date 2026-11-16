import { createHash, randomBytes } from 'node:crypto'
import {
  CSRF_HEADER,
  GITHUB_WEBHOOK_PATH,
  RUNNER_CALLBACK_PATH,
  currentTime,
  type ApiErrorBody,
  type ApiErrorCode,
  type AuthMethod,
} from '@hinomi/shared'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { clientAddress, remoteAddress, type AccessOptions } from '../access/index.js'
import type { AuthConfig } from '../config.js'
import type { AuthPasskeyRow, AuthSessionRow } from '../db/schema.js'
import { silentLogger, type Logger } from '../log.js'
import type { AuditInput, Repositories } from '../repository/index.js'
import { stillAdmitted } from './allowlist.js'
import { readGithubPins } from './github-pins.js'
import { safeEqual } from './oidc.js'
import { createThrottle, type Throttle } from './throttle.js'

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
/** And after this long whatever happens, so a stolen cookie has a bounded life. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
/** last_seen_at is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60 * 1000
const MAX_TOKEN_LENGTH = 128

/**
 * Routes reachable without a session while HINOMI_AUTH is on. Everything else under /api answers
 * 401, unknown paths included, so nothing can be probed. The webhook receivers check their own
 * signatures. api/auth-routes.test.ts walks every registered route against this list.
 */
export const PUBLIC_ROUTES: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/api/health'],
  ['GET', '/api/auth/session'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/auth/oidc/start'],
  ['GET', '/api/auth/oidc/callback'],
  ['GET', '/api/auth/github/start'],
  ['GET', '/api/auth/github/callback'],
  ['POST', '/api/auth/passkey/login/options'],
  ['POST', '/api/auth/passkey/login'],
  ['POST', '/api/auth/setup/verify'],
  ['POST', '/api/auth/setup/register'],
  ['POST', GITHUB_WEBHOOK_PATH],
  ['POST', RUNNER_CALLBACK_PATH],
]

const WEBHOOK_PATHS = new Set([GITHUB_WEBHOOK_PATH, RUNNER_CALLBACK_PATH])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isPublicRoute(method: string, path: string): boolean {
  const asGet = method === 'HEAD' ? 'GET' : method
  return PUBLIC_ROUTES.some(([m, p]) => m === asGet && p === path)
}

const errorBody = (code: ApiErrorCode, message: string): ApiErrorBody => ({
  error: { code, message },
})
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export interface CoreOptions {
  /** Null while HINOMI_AUTH is off: no session is needed, changes are still audited. */
  config: AuthConfig | null
  repositories: Pick<Repositories, 'auth' | 'audit' | 'settings'>
  access?: AccessOptions
  log?: Logger
  now?: () => Date
  throttle?: Throttle
  /** Counts anonymous starts (passkey challenges, provider redirects) per client address. */
  starts?: Throttle
}

export interface StartSession {
  method: AuthMethod
  subject: string
  passkeyId?: number | null
}

/**
 * The session core every login path goes through, and the guard in front of /api. One seam
 * starts sessions (startSession), so rotation, cookie attributes and the login audit row are the
 * same for passkeys, OpenID Connect and GitHub.
 */
export function createAuthCore({
  config,
  repositories,
  access = {},
  log = silentLogger,
  now = currentTime,
  throttle = createThrottle({ now: () => now().getTime() }),
  starts = createThrottle({
    freeFailures: 30,
    baseDelayMs: 1000,
    maxDelayMs: 5 * 60 * 1000,
    forgetAfterMs: 15 * 60 * 1000,
    now: () => now().getTime(),
  }),
}: CoreOptions) {
  const store = repositories.auth
  const cookieName = config?.secure ? '__Host-hinomi_session' : 'hinomi_session'
  const sessions = new WeakMap<Request, AuthSessionRow>()

  let warnedUntrustedForward = false

  function ipOf(c: Context): string | null {
    const client = clientAddress(
      { remoteAddress: remoteAddress(c), header: (name) => c.req.header(name) },
      access,
    )
    if (!client.forwarded && !warnedUntrustedForward && c.req.header('x-forwarded-for')) {
      // Behind a proxy that is not in HINOMI_TRUSTED_PROXIES every client shares the proxy's
      // address, so the backoff and the audit log see one client. Said once, not per request.
      warnedUntrustedForward = true
      log.warn(
        'auth: X-Forwarded-For came from a peer that is not in HINOMI_TRUSTED_PROXIES, so it is ignored; list your reverse proxy there',
        { peer: client.ip?.address ?? null },
      )
    }
    return client.ip?.address ?? null
  }

  /** Writes the audit row or throws: for logins, which must not happen unrecorded. */
  function auditOrThrow(c: Context | null, input: AuditInput): void {
    repositories.audit.record({ ...input, ip: input.ip ?? (c ? ipOf(c) : null) }, now())
  }

  function audit(c: Context | null, input: AuditInput): void {
    try {
      repositories.audit.record({ ...input, ip: input.ip ?? (c ? ipOf(c) : null) }, now())
    } catch (error) {
      // The action already happened; a failed audit write is loud in the log, never a 500.
      log.error('audit: could not write an event', {
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function tokenOf(c: Context): string | null {
    const token = getCookie(c, cookieName)
    if (!token || token.length > MAX_TOKEN_LENGTH) return null
    return token
  }

  /** The live session of this request, ending it when it is past its idle or absolute limit. */
  function resolve(c: Context): AuthSessionRow | null {
    const cached = sessions.get(c.req.raw)
    if (cached) return cached
    const token = tokenOf(c)
    if (!token) return null
    const hash = sha256Hex(token)
    const row = store.sessions.byTokenHash(hash)
    if (!row) return null
    const at = now().getTime()
    if (row.expiresAt.getTime() <= at || row.lastSeenAt.getTime() + SESSION_IDLE_MS <= at) {
      store.sessions.removeByTokenHash(hash)
      return null
    }
    if (at - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) store.sessions.touch(hash, new Date(at))
    sessions.set(c.req.raw, row)
    return row
  }

  function cookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      secure: config?.secure ?? false,
      sameSite: 'Lax' as const,
      path: '/',
      maxAge: maxAgeSeconds,
    }
  }

  /** Starts a session: the old one of this browser ends (rotation), a new token is set. */
  function startSession(c: Context, input: StartSession): AuthSessionRow {
    const old = tokenOf(c)
    if (old) store.sessions.removeByTokenHash(sha256Hex(old))
    const at = now()
    store.sessions.removeExpired(at, new Date(at.getTime() - SESSION_IDLE_MS))
    const token = randomToken()
    const ip = ipOf(c)
    const row = store.sessions.create({
      tokenHash: sha256Hex(token),
      publicId: randomToken(12),
      csrfToken: randomToken(),
      method: input.method,
      subject: input.subject,
      passkeyId: input.passkeyId ?? null,
      createdAt: at,
      expiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_MS),
      ip,
      userAgent: c.req.header('user-agent')?.slice(0, 200) ?? null,
    })
    // The audit row first: a login that cannot be recorded does not happen.
    try {
      auditOrThrow(c, { action: 'login', actor: input.subject, ip, detail: input.method })
    } catch (error) {
      store.sessions.removeByTokenHash(row.tokenHash)
      log.error('auth: login refused, the audit log could not be written', {
        error: error instanceof Error ? error.message : 'unexpected error',
      })
      throw new Error('could not record the login', { cause: error })
    }
    setCookie(c, cookieName, token, cookieOptions(SESSION_ABSOLUTE_MS / 1000))
    sessions.set(c.req.raw, row)
    if (ip) {
      throttle.succeed([`ip:${ip}`])
      starts.succeed([`ip:${ip}`])
    }
    return row
  }

  /** Ends this browser's session, server side first. */
  function endSession(c: Context): AuthSessionRow | null {
    const row = resolve(c)
    const token = tokenOf(c)
    if (token) store.sessions.removeByTokenHash(sha256Hex(token))
    deleteCookie(c, cookieName, { path: '/', secure: config?.secure ?? false })
    sessions.delete(c.req.raw)
    return row
  }

  /**
   * True when a change may come from this browser context: the Origin header, when sent, is the
   * public URL; without it, Sec-Fetch-Site (when sent) says same origin or a direct navigation.
   */
  function sameOrigin(c: Context): boolean {
    if (!config) return true
    const origin = c.req.header('origin')
    if (origin !== undefined) return origin === config.publicOrigin
    const site = c.req.header('sec-fetch-site')
    return site === undefined || site === 'same-origin' || site === 'none'
  }

  function csrfOk(c: Context, row: AuthSessionRow): boolean {
    const sent = c.req.header(CSRF_HEADER)
    return sent !== undefined && safeEqual(sent, row.csrfToken)
  }

  /**
   * In front of every /api route. With auth on: a session or a public route, and for a change
   * the session's CSRF token and the public origin. With auth on or off: every change that
   * succeeds is written to the audit log.
   */
  const guard: MiddlewareHandler = async (c, next) => {
    const method = c.req.method
    const path = c.req.path
    const unsafe = !SAFE_METHODS.has(method)
    const webhook = WEBHOOK_PATHS.has(path)
    let row: AuthSessionRow | null = null

    if (config && !webhook) {
      row = resolve(c)
      if (unsafe && !sameOrigin(c)) {
        return c.json(errorBody('forbidden', 'This change came from another site'), 403)
      }
      if (!isPublicRoute(method, path)) {
        if (!row) {
          c.header('cache-control', 'no-store')
          return c.json(errorBody('unauthenticated', 'Sign in to Hinomi first'), 401)
        }
        if (unsafe && !csrfOk(c, row)) {
          return c.json(errorBody('forbidden', 'The request is missing its CSRF token'), 403)
        }
      }
    }

    await next()

    if (unsafe && !webhook && !path.startsWith('/api/auth/') && c.res.status < 400) {
      audit(c, {
        action: 'change',
        actor: row?.subject ?? null,
        method,
        path,
        status: c.res.status,
      })
    }
  }

  /**
   * Whether the owner of a passkey may still sign in: always for a setup code; for a provider,
   * only while that provider is configured and its subject is still on the allow list.
   */
  function ownerAdmitted(passkey: Pick<AuthPasskeyRow, 'ownerMethod' | 'ownerSubject'>): boolean {
    if (passkey.ownerMethod === 'setup-code') return true
    if (!config?.[passkey.ownerMethod]) return false
    return stillAdmitted(
      config.allowed,
      passkey.ownerSubject,
      readGithubPins(repositories.settings),
    )
  }

  /** Removes a passkey whose owner left the allow list, with the sessions it started. */
  function prunePasskey(c: Context | null, passkey: AuthPasskeyRow): void {
    if (!store.passkeys.remove(passkey.id)) return
    store.sessions.removeByPasskey(passkey.id)
    audit(c, {
      action: 'passkey_removed',
      actor: passkey.ownerSubject,
      detail: `${passkey.name}: its owner is no longer in HINOMI_AUTH_ALLOWED`,
    })
    log.info('auth: removed a passkey whose owner is no longer allowed', {
      passkeyId: passkey.id,
    })
  }

  /** Housekeeping at boot: expired sessions, and sessions a changed configuration no longer allows. */
  function startup(): void {
    if (!config) {
      // Turning auth off and on again later must not bring old sessions back.
      const removed = store.sessions.removeAll()
      if (removed > 0) log.info('auth: off, removed old sessions', { removed })
      return
    }
    const at = now()
    store.sessions.removeExpired(at, new Date(at.getTime() - SESSION_IDLE_MS))
    const pins = readGithubPins(repositories.settings)
    const dropped =
      store.sessions.removeWhere(
        ['oidc'],
        (s) => !!config.oidc && stillAdmitted(config.allowed, s, pins),
      ) +
      store.sessions.removeWhere(
        ['github'],
        (s) => !!config.github && stillAdmitted(config.allowed, s, pins),
      )
    if (dropped > 0) log.info('auth: ended sessions the allow list no longer covers', { dropped })
    for (const passkey of store.passkeys.list()) {
      if (!ownerAdmitted(passkey)) prunePasskey(null, passkey)
    }
  }

  return {
    config,
    cookieName,
    throttle,
    starts,
    ownerAdmitted,
    prunePasskey,
    now,
    log,
    store,
    settings: repositories.settings,
    guard,
    resolve,
    startSession,
    endSession,
    sameOrigin,
    csrfOk,
    ipOf,
    audit,
    tokenHashOf: (c: Context) => {
      const token = tokenOf(c)
      return token ? sha256Hex(token) : null
    },
    startup,
  }
}

export type AuthCore = ReturnType<typeof createAuthCore>
