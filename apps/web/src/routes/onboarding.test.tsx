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
import { currentTime } from '@hinomi/shared'

const unconfigured = (over: Record<string, unknown> = {}) => ({
  'GET /health': { status: 'ok', version: '0.3.0' },
  'GET /shell/nav-counts': {
    needsAction: null,
    deployments: null,
    alerts: null,
    activeFixRuns: null,
    guards: null,
  },
  'GET /shell/scan-status': { state: 'unconfigured' },
  'GET /onboarding': { finished: false, alertsSkipped: false },
  'GET /sources': { sources: [], canStoreTokens: true },
  'GET /notifications/channels': { items: [] },
  'GET /settings': {
    scanIntervalMinutes: 360,
    osvEnabled: true,
    includeAccountRepos: false,
    updateCheckEnabled: true,
    supportWindowDays: 90,
    imageScan: 'off',
    rustBehindReleases: 4,
    bunBehindReleases: 4,
  },
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

  it('shows where to get a GitHub token above the GitHub token form', async () => {
    mockApi(unconfigured({ 'GET /sources': { sources: [coolifySource], canStoreTokens: true } }))
    await renderApp('/onboarding')
    const help = await screen.findByRole('region', { name: 'Create a GitHub token' })
    expect(within(help).getByRole('link', { name: 'Create a classic token' })).toHaveAttribute(
      'href',
      'https://github.com/settings/tokens/new?scopes=repo,security_events&description=Hinomi',
    )
    const token = screen.getByLabelText('Personal access token', {
      selector: 'input:not([type=radio])',
    })
    // The help comes first in the step, so it is read before the field.
    expect(help.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
      'Reading deployments, Skipped, Apps, domains and servers from Coolify',
      'Fetching open alerts, Done, Dependabot alerts of every repo',
      'Scanning lockfiles with OSV.dev, 40%, 2 of 5 repos',
      'Matching repos to apps, Waiting, Each app joined with the repo it runs',
      'Ranking by exposure, Waiting, Public and critical first',
    ])
    expect(lines[2]).toHaveAttribute('aria-current', 'step')
  })

  it('shows the first scan as starting while it is queued', async () => {
    mockApi(
      unconfigured({
        'GET /shell/scan-status': { state: 'queued', nextScanAt: currentTime().toISOString() },
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

  it('moves between steps from the steps pane, with Continue and Back', async () => {
    mockApi(
      unconfigured({
        'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
        'GET /onboarding': { finished: false, alertsSkipped: true },
        'GET /scans': { items: [] },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/onboarding')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Run the first scan' }),
    ).toBeVisible()
    const steps = within(screen.getByRole('list', { name: 'Setup steps' }))
    expect(steps.getByRole('button', { name: /Step 4: First scan/ }).closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    )
    await user.click(steps.getByRole('button', { name: /Step 1: Connect Coolify/ }))
    expect(screen.getByRole('heading', { level: 1, name: 'Connect Coolify' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Connect GitHub' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Connect Coolify' })).toBeVisible()
  })

  it('keeps later steps locked until the one before is done', async () => {
    mockApi(unconfigured())
    const user = userEvent.setup()
    await renderApp('/onboarding')
    const steps = within(await screen.findByRole('list', { name: 'Setup steps' }))
    const scan = steps.getByRole('button', { name: /Step 4: First scan/ })
    expect(scan).toHaveAttribute('aria-disabled', 'true')
    await user.click(scan)
    expect(screen.getByRole('heading', { level: 1, name: 'Connect Coolify' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Back to Hinomi' })).not.toBeInTheDocument()
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
