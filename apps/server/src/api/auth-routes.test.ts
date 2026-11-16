import { describe, expect, it } from 'vitest'
import { isPublicRoute, parseAllowRules, PUBLIC_ROUTES } from '../auth/index.js'
import { IDP_CLIENT_ID, IDP_CLIENT_SECRET, IDP_ISSUER } from '../auth/testing.js'
import { createTestApi } from './testing.js'

const ORIGIN = 'https://hinomi.example.dev'

/** Every route of the full app, with OpenID Connect and GitHub on so their routes exist too. */
function fullApp() {
  return createTestApi({
    auth: {
      config: {
        publicOrigin: ORIGIN,
        secure: true,
        rpId: 'hinomi.example.dev',
        oidc: {
          issuer: IDP_ISSUER,
          clientId: IDP_CLIENT_ID,
          clientSecret: IDP_CLIENT_SECRET,
          name: 'SSO',
          tokenOrigin: null,
        },
        github: { clientId: 'gh-client', clientSecret: 'gh-secret-fictional-0001' },
        allowed: parseAllowRules('ops@example.dev'),
      },
      // Nothing may leave the test: a provider call would mean a route ran without a session.
      fetch: () => Promise.reject(new Error('no network in this test')),
    },
  })
}

/** A concrete path for a route pattern: params become `1`, wildcards `x`. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, '1').replace(/\*/g, 'x')
}

describe('every API route is behind the login', () => {
  const { app } = fullApp()
  const routes = app.routes
    .filter((r) => r.path.startsWith('/api'))
    .flatMap((r) =>
      (r.method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [r.method]).map(
        (method) => ({
          method,
          pattern: r.path,
          path: concrete(r.path),
        }),
      ),
    )
  const unique = [...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values()]

  it('finds the routes to check', () => {
    // A sanity floor: if routing changes shape and this finds nothing, the test below proves nothing.
    expect(unique.length).toBeGreaterThan(80)
  })

  it.each(unique.filter((r) => !isPublicRoute(r.method, r.path)))(
    '$method $pattern answers 401 without a session',
    async ({ method, path }) => {
      const res = await app.request(path, {
        method,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        ...(method !== 'GET' && method !== 'HEAD' && { body: '{}' }),
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'Sign in to Hinomi first' },
      })
    },
  )

  it('lists only public routes that exist', () => {
    const registered = new Set(unique.map((r) => `${r.method} ${r.path}`))
    for (const [method, path] of PUBLIC_ROUTES) {
      expect(registered.has(`${method} ${path}`), `${method} ${path}`).toBe(true)
    }
  })

  it('keeps the public list to the login, health and the signed webhooks', () => {
    expect(PUBLIC_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/health',
      'GET /api/auth/session',
      'POST /api/auth/logout',
      'GET /api/auth/oidc/start',
      'GET /api/auth/oidc/callback',
      'GET /api/auth/github/start',
      'GET /api/auth/github/callback',
      'POST /api/auth/passkey/login/options',
      'POST /api/auth/passkey/login',
      'POST /api/auth/setup/verify',
      'POST /api/auth/setup/register',
      'POST /api/github/webhook',
      'POST /api/runner/callback',
    ])
  })

  it('answers paths that differ only by a trailing slash or case with 401 or no API at all', async () => {
    for (const path of ['/api/overview/', '/api/health/', '/api/audit']) {
      expect((await app.request(path)).status, path).toBe(401)
    }
    expect((await app.request('/API/overview')).status).not.toBe(200)
  })
})
