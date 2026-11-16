import { createHash, randomBytes } from 'node:crypto'
import {
  addPasskeyRequestSchema,
  authSessionSchema,
  authSessionsResponseSchema,
  passkeyCreationOptionsSchema,
  passkeyLoginRequestSchema,
  passkeyRequestOptionsSchema,
  passkeysResponseSchema,
  setupCodeRequestSchema,
  setupCodeResponseSchema,
  setupRegisterRequestSchema,
  type AuthSession,
  type LoginError,
  type PasskeyRegistration,
} from '@hinomi/shared'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  admit,
  CEREMONY_TIMEOUT_MS,
  consumeSetupCode,
  createGithubLogin,
  createOidcClient,
  createPendingStore,
  creationOptions,
  OidcError,
  readClientData,
  requestOptions,
  safeEqual,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type AuthCore,
  type GithubLogin,
  type OidcClient,
  type ProvenIdentity,
  type RelyingParty,
} from '../../auth/index.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'

/** A login attempt at a provider may take this long, from the redirect to the callback. */
const FLOW_TTL_MS = 10 * 60 * 1000
const USER_HANDLE_KEY = 'auth.userHandle'

type Challenge =
  { kind: 'login' } | { kind: 'setup'; enrollmentId: string } | { kind: 'add'; tokenHash: string }

interface Flow {
  provider: 'oidc' | 'github'
  state: string
  nonce: string
  codeVerifier: string
  next: string
}

const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
const iso = (date: Date) => date.toISOString()

/**
 * Where to go after a login: a path on this site, never another host (`//evil`, `/\evil`) and
 * never an API route.
 */
export function safeNext(value: string | undefined): string {
  if (!value || value.length > 500) return '/'
  if (!/^\/(?![/\\])[^\s\\]*$/.test(value) || value.startsWith('/api/')) return '/'
  return value
}

export interface AuthRouteOptions {
  core: AuthCore
  fetch?: typeof fetch
}

/** /api/auth: the session, logins, passkeys and sessions. */
export function authRoutes({ core, fetch: fetchImpl }: AuthRouteOptions) {
  const app = new Hono()
  const { config, store, throttle } = core

  app.get('/session', (c) => {
    c.header('cache-control', 'no-store')
    const row = config ? core.resolve(c) : null
    const body: AuthSession = {
      enabled: config !== null,
      methods: {
        oidc: config?.oidc ? { name: config.oidc.name } : null,
        github: config?.github !== null && config?.github !== undefined,
        passkey: config !== null,
      },
      session: row && {
        subject: row.subject,
        method: row.method,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        csrfToken: row.csrfToken,
      },
    }
    return send(c, authSessionSchema, body)
  })

  // Everything below exists only while auth is on.
  if (!config) return app

  const rp: RelyingParty = { id: config.rpId, origin: config.publicOrigin }
  const challenges = createPendingStore<Challenge>({
    ttlMs: CEREMONY_TIMEOUT_MS + 60_000,
    now: () => core.now().getTime(),
  })
  const flows = createPendingStore<Flow>({
    ttlMs: FLOW_TTL_MS,
    now: () => core.now().getTime(),
  })
  const flowCookie = config.secure ? '__Host-hinomi_login' : 'hinomi_login'
  const oidc: OidcClient | null = config.oidc
    ? createOidcClient({
        ...config.oidc,
        redirectUri: `${config.publicOrigin}/api/auth/oidc/callback`,
        ...(fetchImpl && { fetch: fetchImpl }),
        now: () => core.now().getTime(),
      })
    : null
  const github: GithubLogin | null = config.github
    ? createGithubLogin({
        ...config.github,
        redirectUri: `${config.publicOrigin}/api/auth/github/callback`,
        ...(fetchImpl && { fetch: fetchImpl }),
      })
    : null

  function userHandle(): string {
    const stored = core.settings.get(USER_HANDLE_KEY, z.string().min(16))
    if (stored) return stored
    const handle = randomToken()
    core.settings.set(USER_HANDLE_KEY, handle)
    return handle
  }

  function ipKeys(c: Context): string[] {
    const ip = core.ipOf(c)
    return ip ? [`ip:${ip}`] : []
  }

  /** 429 with Retry-After when any key is locked. */
  function checkThrottle(c: Context, keys: string[]): void {
    const verdict = throttle.check(keys)
    if (verdict.allowed) return
    c.header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
    throw new HttpError(
      429,
      'rate_limited',
      'Too many failed attempts, wait a moment and try again',
    )
  }

  /** A failed login: counted against the keys, audited, answered without the reason. */
  function loginFailed(
    c: Context,
    keys: string[],
    reason: string,
    actor: string | null = null,
  ): never {
    throttle.fail(keys)
    core.audit(c, { action: 'login_failed', actor, detail: reason })
    core.log.warn('auth: login refused', { reason })
    throw new HttpError(401, 'unauthenticated', 'That did not work, try again')
  }

  function requireSession(c: Context) {
    const row = core.resolve(c)
    if (!row) throw new HttpError(401, 'unauthenticated', 'Sign in to Hinomi first')
    return row
  }

  function newRegistration(kind: Challenge) {
    const challenge = randomToken()
    challenges.put(challenge, kind)
    return creationOptions({
      rp,
      userHandle: userHandle(),
      challenge,
      exclude: store.passkeys.list().map((p) => p.credentialId),
    })
  }

  /** Reads and checks a registration whose challenge must be of the `expected` kind. */
  function registration(credential: PasskeyRegistration, expected: (c: Challenge) => boolean) {
    const clientData = readClientData(rp, credential.response.clientDataJSON, 'webauthn.create')
    const pending = challenges.take(clientData.challenge)
    if (!pending || !expected(pending)) throw new WebAuthnError('unknown or expired challenge')
    return verifyRegistration(rp, credential)
  }

  app.post('/logout', (c) => {
    const row = core.resolve(c)
    if (row && !core.csrfOk(c, row)) {
      throw new HttpError(403, 'forbidden', 'The request is missing its CSRF token')
    }
    const ended = core.endSession(c)
    if (ended) core.audit(c, { action: 'logout', actor: ended.subject })
    return c.body(null, 204)
  })

  // -------------------------------------------------------------------------
  // OpenID Connect and GitHub: redirect out, come back to the callback

  async function startFlow(c: Context, provider: 'oidc' | 'github'): Promise<Response> {
    const keys = ipKeys(c)
    if (!throttle.check(keys).allowed) return c.redirect('/login?error=rate_limited', 302)
    const flowId = randomToken()
    const flow: Flow = {
      provider,
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: randomToken(48),
      next: safeNext(c.req.query('next')),
    }
    let target: string
    try {
      target =
        provider === 'oidc' && oidc
          ? await oidc.authorizationUrl({
              state: flow.state,
              nonce: flow.nonce,
              codeChallenge: s256(flow.codeVerifier),
            })
          : (github as GithubLogin).authorizationUrl({
              state: flow.state,
              codeChallenge: s256(flow.codeVerifier),
            })
    } catch (error) {
      core.log.warn('auth: provider not reachable', {
        provider,
        error: error instanceof OidcError ? error.message : 'unexpected error',
      })
      return c.redirect('/login?error=failed', 302)
    }
    flows.put(flowId, flow)
    setCookie(c, flowCookie, flowId, {
      httpOnly: true,
      secure: config?.secure ?? false,
      sameSite: 'Lax',
      path: '/',
      maxAge: FLOW_TTL_MS / 1000,
    })
    c.header('cache-control', 'no-store')
    return c.redirect(target, 302)
  }

  async function finishFlow(c: Context, provider: 'oidc' | 'github'): Promise<Response> {
    c.header('cache-control', 'no-store')
    const fail = (reason: LoginError) => c.redirect(`/login?error=${reason}`, 302)
    const keys = ipKeys(c)
    const flowId = getCookie(c, flowCookie)
    deleteCookie(c, flowCookie, { path: '/', secure: config?.secure ?? false })
    const flow = flowId ? flows.take(flowId) : undefined
    const state = c.req.query('state')
    if (!flow || flow.provider !== provider || !state || !safeEqual(state, flow.state)) {
      return fail('expired')
    }
    if (!throttle.check(keys).allowed) return fail('rate_limited')
    const code = c.req.query('code')
    if (!code || c.req.query('error')) {
      throttle.fail(keys)
      core.audit(c, { action: 'login_failed', detail: `${provider}: the provider refused` })
      return fail('failed')
    }
    let identity: ProvenIdentity
    try {
      identity =
        provider === 'oidc' && oidc
          ? await oidc.exchange({ code, codeVerifier: flow.codeVerifier, nonce: flow.nonce })
          : await (github as GithubLogin).exchange({ code, codeVerifier: flow.codeVerifier })
    } catch (error) {
      throttle.fail(keys)
      const reason = error instanceof OidcError ? error.message : 'unexpected error'
      core.audit(c, { action: 'login_failed', detail: `${provider}: ${reason}` })
      core.log.warn('auth: provider login failed', { provider, error: reason })
      return fail('failed')
    }
    const subject = admit(config?.allowed ?? [], identity)
    if (!subject) {
      throttle.fail(keys)
      const who =
        provider === 'github'
          ? `github:${identity.id}`
          : (identity.verifiedEmails[0] ?? `oidc:${identity.id}`)
      core.audit(c, {
        action: 'login_failed',
        actor: who,
        detail: `${provider}: not in HINOMI_AUTH_ALLOWED`,
      })
      return fail('not_allowed')
    }
    core.startSession(c, { method: provider, subject })
    return c.redirect(flow.next, 302)
  }

  if (oidc) {
    app.get('/oidc/start', (c) => startFlow(c, 'oidc'))
    app.get('/oidc/callback', (c) => finishFlow(c, 'oidc'))
  }
  if (github) {
    app.get('/github/start', (c) => startFlow(c, 'github'))
    app.get('/github/callback', (c) => finishFlow(c, 'github'))
  }

  // -------------------------------------------------------------------------
  // Passkey login

  app.post('/passkey/login/options', (c) => {
    checkThrottle(c, ipKeys(c))
    const challenge = randomToken()
    challenges.put(challenge, { kind: 'login' })
    return send(c, passkeyRequestOptionsSchema, requestOptions({ rp, challenge }))
  })

  app.post('/passkey/login', async (c) => {
    const keys = ipKeys(c)
    checkThrottle(c, keys)
    const { credential } = await readJson(c, passkeyLoginRequestSchema)
    try {
      const clientData = readClientData(rp, credential.response.clientDataJSON, 'webauthn.get')
      const pending = challenges.take(clientData.challenge)
      if (pending?.kind !== 'login') throw new WebAuthnError('unknown or expired challenge')
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error
      loginFailed(c, keys, `passkey: ${error.message}`)
    }
    const passkey = store.passkeys.byCredentialId(credential.id)
    if (!passkey) loginFailed(c, keys, 'passkey: unknown credential')
    const accountKeys = [...keys, `account:passkey:${passkey.id}`]
    checkThrottle(c, accountKeys)
    let signCount: number
    try {
      signCount = verifyAssertion(rp, credential, passkey, userHandle()).signCount
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error
      loginFailed(c, accountKeys, `passkey: ${error.message}`, passkey.name)
    }
    if (!store.passkeys.recordUse(passkey.id, passkey.signCount, signCount, core.now())) {
      loginFailed(c, accountKeys, 'passkey: counter changed during the login', passkey.name)
    }
    throttle.succeed(accountKeys)
    core.startSession(c, { method: 'passkey', subject: passkey.name, passkeyId: passkey.id })
    return c.body(null, 204)
  })

  // -------------------------------------------------------------------------
  // Setup codes: the first passkey, or a new one after `hinomi-auth reset`

  app.post('/setup/verify', async (c) => {
    const keys = [...ipKeys(c), 'account:setup']
    checkThrottle(c, keys)
    const { code } = await readJson(c, setupCodeRequestSchema)
    if (!consumeSetupCode(core.settings, code, core.now())) {
      loginFailed(c, keys, 'setup code: wrong or expired')
    }
    throttle.succeed(keys)
    core.audit(c, { action: 'setup_code_used' })
    const enrollmentId = randomToken()
    const options = newRegistration({ kind: 'setup', enrollmentId })
    return send(c, setupCodeResponseSchema, { enrollmentId, options })
  })

  app.post('/setup/register', async (c) => {
    const keys = ipKeys(c)
    checkThrottle(c, keys)
    const { enrollmentId, name, credential } = await readJson(c, setupRegisterRequestSchema)
    let verified
    try {
      verified = registration(
        credential,
        (p) => p.kind === 'setup' && safeEqual(p.enrollmentId, enrollmentId),
      )
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error
      loginFailed(c, keys, `setup passkey: ${error.message}`)
    }
    const passkey = store.passkeys.create({ ...verified, name })
    if (!passkey) throw new HttpError(409, 'conflict', 'This passkey is registered already')
    core.audit(c, { action: 'passkey_added', actor: name, detail: 'with a setup code' })
    core.startSession(c, { method: 'passkey', subject: name, passkeyId: passkey.id })
    return c.body(null, 204)
  })

  // -------------------------------------------------------------------------
  // Signed in: passkeys and sessions

  app.get('/passkeys', (c) => {
    requireSession(c)
    return send(c, passkeysResponseSchema, {
      passkeys: store.passkeys.list().map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: iso(p.createdAt),
        lastUsedAt: p.lastUsedAt ? iso(p.lastUsedAt) : null,
      })),
    })
  })

  app.post('/passkeys/options', (c) => {
    requireSession(c)
    const tokenHash = core.tokenHashOf(c) as string
    return send(c, passkeyCreationOptionsSchema, newRegistration({ kind: 'add', tokenHash }))
  })

  app.post('/passkeys', async (c) => {
    const row = requireSession(c)
    const tokenHash = core.tokenHashOf(c) as string
    const { name, credential } = await readJson(c, addPasskeyRequestSchema)
    let verified
    try {
      verified = registration(credential, (p) => p.kind === 'add' && p.tokenHash === tokenHash)
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error
      core.log.warn('auth: passkey registration refused', { reason: error.message })
      throw new HttpError(400, 'bad_request', 'The passkey could not be verified, try again', {
        cause: error,
      })
    }
    const passkey = store.passkeys.create({ ...verified, name })
    if (!passkey) throw new HttpError(409, 'conflict', 'This passkey is registered already')
    core.audit(c, { action: 'passkey_added', actor: row.subject, detail: name })
    return c.body(null, 204)
  })

  app.delete('/passkeys/:id', (c) => {
    const row = requireSession(c)
    const { id } = readParams(c, z.object({ id: z.coerce.number().int().positive() }))
    const passkeys = store.passkeys.list()
    if (!passkeys.some((p) => p.id === id)) throw notFound('Passkey')
    if (passkeys.length === 1 && !config.oidc && !config.github) {
      throw new HttpError(
        409,
        'conflict',
        'This is the only way to sign in. Add another passkey before removing this one.',
      )
    }
    const removed = store.passkeys.remove(id)
    if (removed) {
      // Sessions it started end with it.
      store.sessions.removeByPasskey(id)
      core.audit(c, { action: 'passkey_removed', actor: row.subject, detail: removed.name })
    }
    return c.body(null, 204)
  })

  app.get('/sessions', (c) => {
    requireSession(c)
    const current = core.tokenHashOf(c)
    return send(c, authSessionsResponseSchema, {
      sessions: store.sessions.list().map((s) => ({
        id: s.publicId,
        subject: s.subject,
        method: s.method,
        createdAt: iso(s.createdAt),
        lastSeenAt: iso(s.lastSeenAt),
        expiresAt: iso(s.expiresAt),
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.tokenHash === current,
      })),
    })
  })

  app.post('/sessions/revoke-others', (c) => {
    const row = requireSession(c)
    const ended = store.sessions.removeOthers(row.tokenHash)
    core.audit(c, {
      action: 'session_revoked',
      actor: row.subject,
      detail: `${ended} other sessions`,
    })
    return c.body(null, 204)
  })

  app.delete('/sessions/:id', (c) => {
    const row = requireSession(c)
    const { id } = readParams(c, z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }))
    const ended = store.sessions.removeByPublicId(id)
    if (!ended) throw notFound('Session')
    core.audit(c, { action: 'session_revoked', actor: row.subject, detail: ended.subject })
    return c.body(null, 204)
  })

  return app
}
