import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, loginOff, loginOn, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'
import { base64url } from '@/lib/webauthn'

const signedOut = loginOn({ session: null })
const unauthenticated = reply(401, {
  error: { code: 'unauthenticated', message: 'Sign in to Hinomi first' },
})

describe('built in login', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a browser without a session to the login page, and back afterwards', async () => {
    const api = mockApi({ ...configuredRoutes(), 'GET /auth/session': signedOut })
    const { router } = await renderApp('/alerts?severity=critical')
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toEqual({ next: '/alerts?severity=critical' })
    expect(await screen.findByRole('heading', { name: 'Sign in to Hinomi' })).toBeVisible()
    // The shell is not drawn, so nothing behind the login is asked for.
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(api.calls.map((c) => c.path)).toEqual(['/auth/session'])
    expect(screen.getByRole('link', { name: 'Sign in with Authentik' })).toHaveAttribute(
      'href',
      '/api/auth/oidc/start?next=%2Falerts%3Fseverity%3Dcritical',
    )
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute(
      'href',
      '/api/auth/github/start?next=%2Falerts%3Fseverity%3Dcritical',
    )
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument()
  })

  it('shows only the ways in that are configured', async () => {
    mockApi({
      'GET /auth/session': {
        ...signedOut,
        methods: { oidc: null, github: false, passkey: true },
      },
    })
    await renderApp('/login')
    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()
    expect(screen.queryByRole('link', { name: /Sign in with/ })).not.toBeInTheDocument()
  })

  it('explains a refused provider login', async () => {
    mockApi({ 'GET /auth/session': signedOut })
    await renderApp('/login?error=not_allowed')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That account is not on the allow list of this Hinomi.',
    )
  })

  it('ignores a next that leaves the site', async () => {
    mockApi({ 'GET /auth/session': signedOut })
    const { router } = await renderApp('/login?next=//evil.example.dev/x')
    expect(router.state.location.search).toEqual({})
    expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute(
      'href',
      '/api/auth/github/start?next=%2F',
    )
  })

  it('leaves the login page alone while the login is off', async () => {
    mockApi({ ...configuredRoutes(), 'GET /auth/session': loginOff })
    const { router } = await renderApp('/login')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('keeps working against a server without the login routes', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /auth/session': reply(404, { error: { code: 'not_found', message: 'Not found' } }),
    })
    const { router } = await renderApp('/alerts')
    expect(router.state.location.pathname).toBe('/alerts')
  })

  it('registers the first passkey with a setup code', async () => {
    let session: unknown = signedOut
    const api = mockApi({
      ...configuredRoutes(),
      'GET /auth/session': () => session,
      'POST /auth/setup/verify': {
        enrollmentId: 'enroll-1',
        options: {
          challenge: 'Y2hhbGxlbmdl',
          rp: { id: 'hinomi.test', name: 'Hinomi' },
          user: { id: 'dXNlcg', name: 'hinomi', displayName: 'Hinomi (hinomi.test)' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 300_000,
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
          attestation: 'none',
        },
      },
      'POST /auth/setup/register': () => {
        session = loginOn()
        return reply(204)
      },
    })
    const credential = {
      id: 'Y3JlZA',
      rawId: new Uint8Array([99, 114, 101, 100]).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([123, 125]).buffer,
        attestationObject: new Uint8Array([160]).buffer,
        getTransports: () => ['internal'],
      },
    }
    const create = vi.fn(() => Promise.resolve(credential))
    vi.stubGlobal('navigator', { ...navigator, credentials: { create } })
    vi.stubGlobal('PublicKeyCredential', class {})
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })

    const user = userEvent.setup()
    const { router } = await renderApp('/login?next=/deployments')
    await user.click(await screen.findByRole('button', { name: 'Use a setup code' }))
    await user.type(screen.getByLabelText('Setup code'), 'abcd-efgh-jkmn')
    await user.type(screen.getByLabelText('Passkey name'), 'MacBook')
    await user.click(screen.getByRole('button', { name: 'Register and sign in' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/deployments'))
    expect(api.called('POST', '/auth/setup/verify')[0]?.body).toEqual({ code: 'abcd-efgh-jkmn' })
    expect(api.called('POST', '/auth/setup/register')[0]?.body).toEqual({
      enrollmentId: 'enroll-1',
      name: 'MacBook',
      credential: {
        id: 'Y3JlZA',
        rawId: 'Y3JlZA',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'oA', transports: ['internal'] },
      },
    })
    const publicKey = (create.mock.calls[0] as unknown as [CredentialCreationOptions])[0].publicKey
    expect(Array.from(new Uint8Array(publicKey?.challenge as ArrayBuffer))).toEqual(
      Array.from(new TextEncoder().encode('challenge')),
    )
  })

  it('sends the csrf token with changes once signed in', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /auth/session': loginOn(),
      'GET /auth/passkeys': { passkeys: [] },
      'GET /auth/sessions': { sessions: [] },
      'POST /auth/logout': reply(204),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=access')
    const access = within(await screen.findByRole('region', { name: 'Access' }))
    expect(await access.findByText('Signed in as ops@example.dev')).toBeVisible()
    await user.click(access.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(api.called('POST', '/auth/logout')).toHaveLength(1))
    expect(api.called('POST', '/auth/logout')[0]?.headers.get('x-hinomi-csrf')).toBe(
      'csrf-fictional-0001',
    )
    // Reads never carry it.
    expect(api.called('GET', '/auth/passkeys')[0]?.headers.get('x-hinomi-csrf')).toBeNull()
  })

  it('goes to the login page when a session ends under the page', async () => {
    let session: unknown = loginOn()
    mockApi({
      ...configuredRoutes(),
      'GET /auth/session': () => session,
      'GET /deployments': () => {
        session = signedOut
        return unauthenticated
      },
    })
    const { router } = await renderApp('/deployments')
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toEqual({ next: '/deployments' })
  })
})

describe('settings with the login on', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists passkeys and sessions and signs the others out', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /auth/session': loginOn(),
      'GET /auth/passkeys': {
        passkeys: [
          {
            id: 1,
            name: 'YubiKey',
            createdAt: '2026-11-01T09:00:00.000Z',
            lastUsedAt: null,
            owner: 'admin',
            ownerMethod: 'setup-code',
          },
          {
            id: 2,
            name: 'Contractor laptop',
            createdAt: '2026-11-03T09:00:00.000Z',
            lastUsedAt: '2026-11-04T09:00:00.000Z',
            owner: 'github:id:583231',
            ownerMethod: 'github',
          },
        ],
      },
      'GET /auth/sessions': {
        sessions: [
          {
            id: 'aaa',
            method: 'passkey',
            subject: 'ops@example.dev',
            createdAt: '2026-11-05T09:00:00.000Z',
            lastSeenAt: '2026-11-05T09:30:00.000Z',
            expiresAt: '2026-11-12T09:00:00.000Z',
            ip: '100.64.0.7',
            userAgent: 'Firefox',
            current: true,
          },
          {
            id: 'bbb',
            method: 'github',
            subject: 'github:id:583231',
            createdAt: '2026-11-04T09:00:00.000Z',
            lastSeenAt: '2026-11-04T10:00:00.000Z',
            expiresAt: '2026-11-11T09:00:00.000Z',
            ip: null,
            userAgent: null,
            current: false,
          },
        ],
      },
      'POST /auth/sessions/revoke-others': reply(204),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=access')
    const access = within(await screen.findByRole('region', { name: 'Access' }))
    expect(await access.findByText('Built in login is on')).toBeVisible()
    const passkeys = within(await access.findByRole('list', { name: 'Passkeys' }))
    expect(passkeys.getByText('YubiKey')).toBeVisible()
    expect(passkeys.getByText('Registered by the admin, with a setup code')).toBeVisible()
    expect(passkeys.getByText('Registered by github:id:583231, through GitHub')).toBeVisible()
    const sessions = within(access.getByRole('list', { name: 'Sessions' }))
    expect(sessions.getByText('This browser')).toBeVisible()
    expect(
      sessions.getByRole('button', { name: 'Sign out the session of github:id:583231' }),
    ).toBeVisible()
    await user.click(access.getByRole('button', { name: 'Sign out the other session' }))
    await waitFor(() => expect(api.called('POST', '/auth/sessions/revoke-others')).toHaveLength(1))
  })

  it('calls a public address behind the login a warning, not an alarm', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /auth/session': loginOn(),
      'GET /auth/passkeys': { passkeys: [] },
      'GET /auth/sessions': { sessions: [] },
      'GET /access': { state: 'public', forwarded: false, address: '203.0.113.9' },
    })
    await renderApp('/settings?sel=access')
    const access = within(await screen.findByRole('region', { name: 'Access' }))
    expect(await access.findByText('Reachable from the internet, behind the login')).toBeVisible()
    const topBar = within(screen.getByRole('banner'))
    expect(await topBar.findByRole('link', { name: 'Public, login required' })).toBeInTheDocument()
    expect(screen.queryByText('Reachable from the internet.')).not.toBeInTheDocument()
  })

  it('says how to turn the login on while it is off', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'tailscale',
        forwarded: false,
        address: '100.64.0.7',
        via: 'address',
        login: null,
      },
    })
    await renderApp('/settings?sel=access')
    const access = within(await screen.findByRole('region', { name: 'Access' }))
    expect(await access.findByText('Built in login is off')).toBeVisible()
    expect(access.getByRole('link', { name: /How to turn it on/ })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/auth.md'),
    )
  })

  it('shows the audit log, newest first, with older pages on demand', async () => {
    const event = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      at: '2026-11-05T09:00:00.000Z',
      action: 'change',
      actor: 'ops@example.dev',
      ip: '100.64.0.7',
      httpMethod: 'PATCH',
      path: '/api/settings',
      status: 200,
      detail: null,
      ...over,
    })
    const api = mockApi({
      ...configuredRoutes(),
      'GET /audit': (_body: unknown, url: URL) =>
        url.searchParams.get('before') === '2'
          ? {
              events: [
                event(1, { action: 'login', httpMethod: null, path: null, detail: 'passkey' }),
              ],
              nextBefore: null,
            }
          : {
              events: [
                event(3),
                event(2, { action: 'login_failed', actor: null, detail: 'not allowed' }),
              ],
              nextBefore: 2,
            },
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=audit')
    const log = within(await screen.findByRole('list', { name: 'Audit log' }))
    expect(log.getByText('PATCH /api/settings')).toBeVisible()
    expect(log.getByText('Sign in refused: not allowed')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Show older' }))
    expect(await log.findByText('Signed in: passkey')).toBeVisible()
    expect(api.called('GET', '/audit').map((c) => c.search.get('before'))).toEqual([null, '2'])
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument()
  })
})

describe('base64url', () => {
  it('round trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250, 1])
    const text = base64url.toB64url(bytes.buffer)
    expect(text).toBe('AP8-P_oB')
    expect(Array.from(new Uint8Array(base64url.fromB64url(text)))).toEqual(Array.from(bytes))
  })
})
