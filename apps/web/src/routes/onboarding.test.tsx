import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredRoutes,
  coolifySource,
  githubSource,
  mockApi,
  reply,
  scanningStatus,
  scanRun,
} from '@/test/mock-api'
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
  'GET /onboarding': { finished: false, alertsSkipped: false },
  'GET /sources': { sources: [], canStoreTokens: true },
  'GET /notifications/channels': { items: [] },
  'GET /settings': { scanIntervalMinutes: 360, osvEnabled: true, includeAccountRepos: false },
  ...over,
})

describe('onboarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
            : scanningStatus(),
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /notifications/channels': { items: [] },
        'GET /onboarding': { finished: false, alertsSkipped: true },
        'PATCH /onboarding': (body: unknown) => ({
          finished: false,
          alertsSkipped: true,
          ...(body as object),
        }),
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
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.click(await screen.findByRole('button', { name: 'Run first scan' }))
    expect(api.called('POST', '/scans')).toHaveLength(1)
    expect(await screen.findByText('First scan done')).toBeInTheDocument()
    expect(screen.getByText(/5 findings opened in 41 seconds/)).toBeInTheDocument()
    const lines = screen.getByRole('list', { name: 'Sources in this scan' })
    expect(within(lines).getByText(/38 repos, 4,917 open alerts/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open exposure view' })).toHaveAttribute('href', '/')
    // Setup is finished on the server, so / stops sending people back here.
    await waitFor(() =>
      expect(api.called('PATCH', '/onboarding').map((c) => c.body)).toEqual([{ finished: true }]),
    )
  })

  it('shows a running scan as phase lines with a progress bar', async () => {
    mockApi(
      unconfigured({
        'GET /shell/scan-status': scanningStatus({ phase: 'lockfiles', skipped: ['deployments'] }),
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /onboarding': { finished: false, alertsSkipped: true },
        'GET /scans': { items: [scanRun()] },
        'GET /scans/7': scanRun(),
      }),
    )
    await renderApp('/onboarding')
    const bar = await screen.findByRole('progressbar', { name: 'First scan' })
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '5')
    const lines = within(screen.getByRole('list', { name: 'Scan phases' })).getAllByRole('listitem')
    expect(lines.map((l) => l.textContent)).toEqual([
      'Reading deployments (skipped)',
      'Fetching open alerts, done',
      'Scanning lockfiles with OSV.dev, 2 of 5 repos',
      'Matching repos to apps, waiting',
      'Ranking by exposure, waiting',
    ])
    expect(lines[2]).toHaveAttribute('aria-current', 'step')
  })

  it('shows the first scan as starting while it is queued', async () => {
    mockApi(
      unconfigured({
        'GET /shell/scan-status': { state: 'queued', nextScanAt: new Date().toISOString() },
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /onboarding': { finished: false, alertsSkipped: true },
        'GET /scans': { items: [] },
      }),
    )
    await renderApp('/onboarding')
    expect(await screen.findByRole('list', { name: 'Scan phases' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'First scan' })).toHaveAttribute(
      'aria-valuetext',
      'Starting the scan',
    )
    expect(screen.queryByRole('button', { name: 'Run first scan' })).not.toBeInTheDocument()
  })

  it('remembers a skipped alerts step on the server', async () => {
    let state = { finished: false, alertsSkipped: false }
    const api = mockApi(
      unconfigured({
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /onboarding': () => state,
        'PATCH /onboarding': (body: unknown) => {
          state = { ...state, ...(body as object) }
          return state
        },
        'GET /scans': { items: [] },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))
    expect(api.called('PATCH', '/onboarding').map((c) => c.body)).toEqual([{ alertsSkipped: true }])
    expect(await screen.findByRole('button', { name: 'Run first scan' })).toBeVisible()
  })

  it('opens on the scan step in a new tab once alerts were skipped', async () => {
    mockApi(
      unconfigured({
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /onboarding': { finished: false, alertsSkipped: true },
        'GET /scans': { items: [] },
      }),
    )
    await renderApp('/onboarding')
    expect(await screen.findByRole('button', { name: 'Run first scan' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument()
  })

  it('sends / to setup while it is not finished, even with sources connected', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /onboarding': { finished: false, alertsSkipped: false },
      'GET /scans': { items: [] },
    })
    const { router } = await renderApp('/')
    expect(router.state.location.pathname).toBe('/onboarding')
  })

  it('stays on / once setup is finished', async () => {
    mockApi(configuredRoutes())
    const { router } = await renderApp('/')
    expect(router.state.location.pathname).toBe('/')
  })
})
