import {
  auditResponseSchema,
  authSessionSchema,
  authSessionsResponseSchema,
  passkeyCreationOptionsSchema,
  passkeyRequestOptionsSchema,
  passkeysResponseSchema,
  setupCodeResponseSchema,
} from '@hinomi/shared'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { api, request, setCsrfToken } from './api'
import { createPasskey, signWithPasskey } from './webauthn'

/**
 * The built in login (docs/auth.md): the session, logins, passkeys, sessions and the audit log.
 * Off by default, then GET /api/auth/session says `enabled: false` and nothing else is called.
 */

const noContent = z.undefined()

export const authKeys = {
  session: ['auth', 'session'] as const,
  passkeys: ['auth', 'passkeys'] as const,
  sessions: ['auth', 'sessions'] as const,
  audit: ['audit'] as const,
}

/** Reading the session also arms the CSRF token every later change carries. */
export const authSessionQuery = queryOptions({
  queryKey: authKeys.session,
  queryFn: async ({ signal }) => {
    const session = await api.get('/auth/session', authSessionSchema, { signal })
    setCsrfToken(session.session?.csrfToken ?? null)
    return session
  },
  staleTime: 60_000,
})

export const passkeysQuery = queryOptions({
  queryKey: authKeys.passkeys,
  queryFn: ({ signal }) => api.get('/auth/passkeys', passkeysResponseSchema, { signal }),
})

export const sessionsQuery = queryOptions({
  queryKey: authKeys.sessions,
  queryFn: ({ signal }) => api.get('/auth/sessions', authSessionsResponseSchema, { signal }),
})

export const auditQuery = infiniteQueryOptions({
  queryKey: authKeys.audit,
  queryFn: ({ signal, pageParam }) =>
    api.get(`/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`, auditResponseSchema, {
      signal,
    }),
  initialPageParam: null as number | null,
  getNextPageParam: (last) => last.nextBefore,
})

/** Where the provider buttons go: a full page redirect, not a fetch. */
export const providerLoginUrl = (provider: 'oidc' | 'github', next: string) =>
  `/api/auth/${provider}/start?next=${encodeURIComponent(next)}`

export const logout = () => api.post('/auth/logout', noContent)

/** The passkey login: a challenge, the browser prompt, then the server checks the signature. */
export async function loginWithPasskey(): Promise<void> {
  const options = await api.post('/auth/passkey/login/options', passkeyRequestOptionsSchema)
  const credential = await signWithPasskey(options)
  await api.post('/auth/passkey/login', noContent, { credential })
}

/** A setup code from the container, then a new passkey; leaves the browser signed in. */
export async function enrollWithSetupCode(code: string, name: string): Promise<void> {
  const { enrollmentId, options } = await api.post('/auth/setup/verify', setupCodeResponseSchema, {
    code,
  })
  const credential = await createPasskey(options)
  await api.post('/auth/setup/register', noContent, { enrollmentId, name, credential })
}

/** Another passkey for the signed in instance. */
export async function addPasskey(name: string): Promise<void> {
  const options = await api.post('/auth/passkeys/options', passkeyCreationOptionsSchema)
  const credential = await createPasskey(options)
  await api.post('/auth/passkeys', noContent, { name, credential })
}

export const removePasskey = (id: number) =>
  request(`/auth/passkeys/${id}`, noContent, { method: 'DELETE' })

export const revokeSession = (id: string) =>
  request(`/auth/sessions/${encodeURIComponent(id)}`, noContent, { method: 'DELETE' })

export const revokeOtherSessions = () => api.post('/auth/sessions/revoke-others', noContent)
