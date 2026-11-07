import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coolifySource, githubSource, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// A fictional key: right shape for the form check, not a real key. Built in parts so secret
// scanners do not mistake the fixture for one.
const MARK = 'PRIVATE KEY-----'
const PEM = `-----BEGIN RSA ${MARK}\nZmljdGlvbmFsLWtlc3RyZWwta2V5\n-----END RSA ${MARK}`

const appSource = {
  ...githubSource,
  name: 'kestrel-co',
  auth: 'github_app' as const,
  appId: '1234',
  installationId: '4242',
}

const base = (over: Record<string, unknown> = {}) => ({
  'GET /health': { status: 'ok', version: '0.3.0' },
  'GET /shell/nav-counts': {
    needsAction: null,
    deployments: null,
    alerts: null,
    activeFixRuns: null,
    guards: null,
  },
  'GET /shell/scan-status': { state: 'unconfigured' },
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

describe('github app connect form', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('connects GitHub as an app in onboarding', async () => {
    let saved = false
    const api = mockApi(
      base({
        'GET /sources': () => ({
          sources: saved ? [coolifySource, appSource] : [coolifySource],
          canStoreTokens: true,
        }),
        'POST /sources/test': (body: unknown) =>
          (body as { installationId: string }).installationId === '4242'
            ? {
                ok: true,
                message: 'Connected to kestrel-co with 3 selected repos',
                account: 'kestrel-co',
                repositorySelection: 'selected',
                repoCount: 3,
                missingPermissions: [],
              }
            : {
                ok: false,
                code: 'not_found',
                message: 'GitHub App installation 9999 was not found',
              },
        'POST /sources': () => {
          saved = true
          return reply(201, appSource)
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/onboarding')
    await user.click(await screen.findByRole('radio', { name: 'GitHub App' }))
    expect(screen.getByText('How to create the app')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Personal access token', { selector: 'input[type=password]' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(screen.getByLabelText('App ID')).toHaveFocus()
    expect(api.called('POST', '/sources/test')).toHaveLength(0)

    await user.type(screen.getByLabelText('App ID'), '1234')
    const installation = screen.getByLabelText('Installation ID')
    await user.type(installation, '9999')
    await user.click(screen.getByLabelText('Private key'))
    await user.paste(PEM)
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(installation).toHaveAttribute('aria-invalid', 'true'))
    expect(installation).toHaveAccessibleDescription(/installation 9999 was not found\./)

    await user.clear(installation)
    await user.type(installation, '4242')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(
      await screen.findByText('Connected to kestrel-co with 3 selected repos'),
    ).toBeInTheDocument()
    expect(api.called('POST', '/sources')[0]?.body).toEqual({
      kind: 'github',
      name: 'kestrel-co',
      baseUrl: null,
      auth: 'github_app',
      appId: '1234',
      installationId: '4242',
      privateKey: PEM,
    })
  })

  it('shows an app source in settings without its key and replaces its credentials', async () => {
    const api = mockApi(
      base({
        'GET /shell/scan-status': { state: 'idle', lastScan: null, nextScanAt: null },
        'GET /sources': { sources: [coolifySource, appSource], canStoreTokens: true },
        'GET /notifications/settings': { publicBaseUrl: null, digestHour: 8 },
        'GET /deployments': { items: [] },
        'GET /repos': { items: [] },
        'GET /scans': { items: [] },
        'POST /sources/test': {
          ok: true,
          message: 'Connected to kestrel-co with all 12 repos',
          account: 'kestrel-co',
        },
        'PATCH /sources/2': appSource,
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    expect(await screen.findByText('App 1234, installation 4242')).toBeInTheDocument()
    expect(screen.getByText('Private key')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Replace credentials' }))
    expect(screen.getByRole('radio', { name: 'GitHub App' })).toBeChecked()
    expect(screen.getByLabelText('App ID')).toHaveValue('1234')
    expect(screen.getByLabelText(/Private key/)).toHaveValue('')
    await user.click(screen.getByLabelText(/Private key/))
    await user.paste(PEM)
    await user.click(screen.getByRole('button', { name: 'Test and save app' }))
    expect(
      await screen.findByText('GitHub App saved. Connected to kestrel-co with all 12 repos.'),
    ).toBeInTheDocument()
    expect(api.called('PATCH', '/sources/2')[0]?.body).toEqual({
      auth: 'github_app',
      appId: '1234',
      installationId: '4242',
      privateKey: PEM,
    })
  })
})
