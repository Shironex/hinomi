import { z } from 'zod'

// Contract of the built in login (HINOMI_AUTH=1, see docs/auth.md). Off by default: then every
// route answers as before and GET /api/auth/session says `enabled: false`.

const isoDate = z.iso.datetime({ offset: true })
const id = z.number().int().positive()

/** How a session was started. */
export const AUTH_METHODS = ['oidc', 'github', 'passkey'] as const
export const authMethodSchema = z.enum(AUTH_METHODS)
export type AuthMethod = z.infer<typeof authMethodSchema>

/** The header the SPA sends with every change, carrying the session's CSRF token. */
export const CSRF_HEADER = 'x-hinomi-csrf'

/** Login error codes the provider callbacks put in `/login?error=`. */
export const LOGIN_ERRORS = [
  /** The provider answered, but the account is not in HINOMI_AUTH_ALLOWED. */
  'not_allowed',
  /** The login took too long, was started in another browser, or was replayed. */
  'expired',
  /** The provider refused, or its answer did not verify. */
  'failed',
  /** Too many failed attempts from this address. */
  'rate_limited',
] as const
export const loginErrorSchema = z.enum(LOGIN_ERRORS)
export type LoginError = z.infer<typeof loginErrorSchema>

/** GET /api/auth/session: public, so the login page knows what to offer. */
export const authSessionSchema = z.object({
  /** False when HINOMI_AUTH is off: nothing below applies and every route is open. */
  enabled: z.boolean(),
  /** The login methods this server offers. */
  methods: z.object({
    /** OpenID Connect, with the button label (HINOMI_AUTH_OIDC_NAME). */
    oidc: z.object({ name: z.string() }).nullable(),
    github: z.boolean(),
    /** Always true when auth is on: passkeys need no provider. */
    passkey: z.boolean(),
  }),
  /** The signed in session, or null. */
  session: z
    .object({
      /** The verified email, `github:<login>`, `oidc:<sub>` or the passkey's name. */
      subject: z.string(),
      method: authMethodSchema,
      createdAt: isoDate,
      expiresAt: isoDate,
      /** Send it back in the x-hinomi-csrf header with every change. */
      csrfToken: z.string(),
    })
    .nullable(),
})
export type AuthSession = z.infer<typeof authSessionSchema>

// ---------------------------------------------------------------------------
// WebAuthn, in the JSON shape of the Level 3 spec (binary fields base64url)

const b64url = z
  .string()
  .max(16 * 1024)
  .regex(/^[A-Za-z0-9_-]*$/, 'must be base64url')

/** PublicKeyCredentialCreationOptionsJSON, the subset Hinomi sends. */
export const passkeyCreationOptionsSchema = z.object({
  challenge: b64url,
  rp: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ id: b64url, name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() })),
  timeout: z.number().int().positive(),
  excludeCredentials: z.array(z.object({ type: z.literal('public-key'), id: b64url })),
  authenticatorSelection: z.object({
    residentKey: z.literal('required'),
    requireResidentKey: z.literal(true),
    userVerification: z.literal('required'),
  }),
  attestation: z.literal('none'),
})
export type PasskeyCreationOptions = z.infer<typeof passkeyCreationOptionsSchema>

/** PublicKeyCredentialRequestOptionsJSON, the subset Hinomi sends (discoverable credentials). */
export const passkeyRequestOptionsSchema = z.object({
  challenge: b64url,
  rpId: z.string(),
  timeout: z.number().int().positive(),
  userVerification: z.literal('required'),
})
export type PasskeyRequestOptions = z.infer<typeof passkeyRequestOptionsSchema>

/** RegistrationResponseJSON, what the browser's create() gives back. */
export const passkeyRegistrationSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
})
export type PasskeyRegistration = z.infer<typeof passkeyRegistrationSchema>

/** AuthenticationResponseJSON, what the browser's get() gives back. */
export const passkeyAssertionSchema = z.object({
  id: b64url,
  rawId: b64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.nullable().optional(),
  }),
})
export type PasskeyAssertion = z.infer<typeof passkeyAssertionSchema>

const passkeyName = z.string().trim().min(1).max(60)

/** POST /api/auth/setup/verify: the one time code from `hinomi-auth setup-code`. */
export const setupCodeRequestSchema = z.object({ code: z.string().trim().min(1).max(64) })
export const setupCodeResponseSchema = z.object({
  /** Names this enrollment in the register call; valid for a few minutes, once. */
  enrollmentId: z.string(),
  options: passkeyCreationOptionsSchema,
})
export type SetupCodeResponse = z.infer<typeof setupCodeResponseSchema>

/** POST /api/auth/setup/register. */
export const setupRegisterRequestSchema = z.object({
  enrollmentId: z.string().min(1).max(128),
  name: passkeyName,
  credential: passkeyRegistrationSchema,
})

/** POST /api/auth/passkeys/options answers this; POST /api/auth/passkeys sends it back. */
export const addPasskeyRequestSchema = z.object({
  name: passkeyName,
  credential: passkeyRegistrationSchema,
})

/** POST /api/auth/passkey/login. */
export const passkeyLoginRequestSchema = z.object({ credential: passkeyAssertionSchema })

export const passkeySchema = z.object({
  id,
  name: z.string(),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
})
export type Passkey = z.infer<typeof passkeySchema>
export const passkeysResponseSchema = z.object({ passkeys: z.array(passkeySchema) })

// ---------------------------------------------------------------------------
// Sessions and the audit log

export const authSessionRowSchema = z.object({
  /** A public handle for revoking, never the cookie value. */
  id: z.string(),
  subject: z.string(),
  method: authMethodSchema,
  createdAt: isoDate,
  lastSeenAt: isoDate,
  expiresAt: isoDate,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** The session this request came with. */
  current: z.boolean(),
})
export type AuthSessionRow = z.infer<typeof authSessionRowSchema>
export const authSessionsResponseSchema = z.object({ sessions: z.array(authSessionRowSchema) })

export const AUDIT_ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'passkey_added',
  'passkey_removed',
  'session_revoked',
  'setup_code_used',
  /** `hinomi-auth reset` from the container: every passkey and session removed. */
  'auth_reset',
  /** A change through the API: a decision on a finding, a setting, a source. */
  'change',
] as const
export const auditActionSchema = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof auditActionSchema>

export const auditEventSchema = z.object({
  id,
  at: isoDate,
  action: auditActionSchema,
  /** Who: the session subject, or null when auth is off or nobody was signed in. */
  actor: z.string().nullable(),
  ip: z.string().nullable(),
  /** For `change`: the HTTP method and path, for example `PATCH /api/findings/12`. */
  httpMethod: z.string().nullable(),
  path: z.string().nullable(),
  status: z.number().int().nullable(),
  /** A short reason or the login method; never a secret or a request body. */
  detail: z.string().nullable(),
})
export type AuditEvent = z.infer<typeof auditEventSchema>

export const auditQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export const auditResponseSchema = z.object({
  events: z.array(auditEventSchema),
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: z.number().int().nullable(),
})
export type AuditResponse = z.infer<typeof auditResponseSchema>
