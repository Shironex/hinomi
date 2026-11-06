import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coolifySource, githubSource, mockApi, reply, scanRun } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const unconfigured = (over: Record<string, unknown> = {}) => ({
  'GET /health': { status: 'ok' },
  'GET /shell/nav-counts': {
    needsAction: null,
    deployments: null,
    alerts: null,
    activeFixRuns: null,
  },
  'GET /shell/scan-status': { state: 'unconfigured' },
  'GET /sources': { sources: [], canStoreTokens: true },
  'GET /notifications/channels': { items: [] },
  'GET /settings': { scanIntervalMinutes: 360, osvEnabled: true, includeAccountRepos: false },
  ...over,
})

describe('onboarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('sends a fresh install from / to setup', async () => {
    mockApi(unconfigured())
    const { router } = await renderApp('/')
    expect(router.state.location.pathname).toBe('/onboarding')
    expect(await screen.findByLabelText('Instance URL')).toBeInTheDocument()
    expect(screen.getByText('Put this behind Tailscale or Cloudflare Access first')).toBeVisible()
  })

  it('explains the missing secret key instead of showing a token form', async () => {
    mockApi(unconfigured({ 'GET /sources': { sources: [], canStoreTokens: false } }))
    await renderApp('/onboarding')
    expect(await screen.findByText('Set HINOMI_SECRET_KEY before connecting')).toBeInTheDocument()
    expect(screen.getByText('openssl rand -base64 32')).toBeInTheDocument()
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
  })

  it('checks the fields before calling the server', async () => {
    const api = mockApi(unconfigured())
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.click(await screen.findByRole('button', { name: 'Test and connect' }))
    const url = screen.getByLabelText('Instance URL')
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(url).toHaveAccessibleDescription(/Enter the Coolify URL\./)
    expect(url).toHaveFocus()

    await user.type(url, 'coolify.example.dev')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(url).toHaveAccessibleDescription(/Must be an http or https URL\./)
    expect(api.called('POST', '/sources/test')).toHaveLength(0)
  })

  it('puts a rejected token by the token field, then connects with a good one', async () => {
    let saved = false
    const api = mockApi(
      unconfigured({
        'POST /sources/test': (body: unknown) =>
          (body as { token: string }).token === 'kestrel-token'
            ? { ok: true, message: 'Connected to Coolify 4.0.0', version: '4.0.0' }
            : { ok: false, code: 'unauthorized', message: 'Coolify rejected the token' },
        'POST /sources': () => {
          saved = true
          return reply(201, coolifySource)
        },
        'GET /sources': () => ({ sources: saved ? [coolifySource] : [], canStoreTokens: true }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.type(await screen.findByLabelText('Instance URL'), 'https://coolify.example.dev/')
    const token = screen.getByLabelText('API token')
    await user.type(token, 'bad-token')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(token).toHaveAttribute('aria-invalid', 'true'))
    expect(token).toHaveAccessibleDescription(/Coolify rejected the token\./)
    expect(api.called('POST', '/sources')).toHaveLength(0)

    await user.clear(token)
    await user.type(token, 'kestrel-token')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(await screen.findByText('Connected to Coolify 4.0.0')).toBeInTheDocument()
    expect(api.called('POST', '/sources')[0]?.body).toEqual({
      kind: 'coolify',
      name: 'coolify.example.dev',
      baseUrl: 'https://coolify.example.dev',
      token: 'kestrel-token',
    })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
  })

  it('shows the secret key fix when the server refuses to store a token', async () => {
    mockApi(
      unconfigured({
        'POST /sources/test': { ok: true, message: 'Connected to Coolify' },
        'POST /sources': reply(400, {
          error: { code: 'secret_key_missing', message: 'HINOMI_SECRET_KEY is not set' },
        }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.type(await screen.findByLabelText('Instance URL'), 'https://coolify.example.dev')
    await user.type(screen.getByLabelText('API token'), 'kestrel-token')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(await screen.findByText('Set HINOMI_SECRET_KEY before connecting')).toBeInTheDocument()
  })

  it('runs the first scan and shows its progress and result', async () => {
    let polls = 0
    const api = mockApi(
      unconfigured({
        'GET /shell/scan-status': () =>
          polls > 0
            ? { state: 'idle', lastScanAt: '2026-11-05T10:00:00.000Z', nextScanAt: null }
            : { state: 'scanning', done: 2, total: 5 },
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /notifications/channels': { items: [] },
        'GET /scans': { items: [] },
        'POST /scans': reply(202, { started: true, run: scanRun() }),
        'GET /scans/7': () => {
          polls++
          return scanRun({
            status: 'succeeded',
            durationMs: 41_000,
            findingsOpened: 5,
            sourceResults: {
              coolify: { status: 'ok', counts: { deployments: 12 } },
              github: { status: 'ok', counts: { repos: 38, alerts: 4917 } },
            },
          })
        },
      }),
    )
    sessionStorage.setItem('hinomi:onboarding-skip-alerts', '1')
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.click(await screen.findByRole('button', { name: 'Run first scan' }))
    expect(api.called('POST', '/scans')).toHaveLength(1)
    expect(await screen.findByText('First scan done')).toBeInTheDocument()
    expect(screen.getByText(/5 findings opened in 41 seconds/)).toBeInTheDocument()
    const lines = screen.getByRole('list', { name: 'Sources in this scan' })
    expect(within(lines).getByText(/38 repos, 4,917 open alerts/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open exposure view' })).toHaveAttribute('href', '/')
  })

  it('shows a running scan as a progress bar', async () => {
    mockApi(
      unconfigured({
        'GET /shell/scan-status': { state: 'scanning', done: 2, total: 5 },
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /scans': { items: [scanRun()] },
        'GET /scans/7': scanRun(),
      }),
    )
    sessionStorage.setItem('hinomi:onboarding-skip-alerts', '1')
    await renderApp('/onboarding')
    const bar = await screen.findByRole('progressbar', { name: 'First scan' })
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '5')
  })
})
