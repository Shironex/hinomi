import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coolifySource, githubSource, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// Adding a Dokploy source in Settings, Sources. The host and key are fictional.

const KEY = 'fictional-dokploy-key-01'

const dokploySource = {
  ...coolifySource,
  id: 9,
  kind: 'dokploy' as const,
  name: 'dokploy.example.dev',
  baseUrl: 'https://dokploy.example.dev',
  deploymentCount: 3,
}

const routes = (sources: unknown[], over: Record<string, unknown> = {}) => ({
  'GET /health': { status: 'ok', version: '0.3.0' },
  'GET /shell/nav-counts': {
    needsAction: null,
    deployments: null,
    alerts: null,
    activeFixRuns: null,
    guards: null,
  },
  'GET /shell/scan-status': { state: 'idle', lastScan: null, nextScanAt: null },
  'GET /notifications/channels': { items: [] },
  'GET /notifications/settings': { publicBaseUrl: null, digestHour: 8 },
  'GET /deployments': { items: [] },
  'GET /repos': { items: [] },
  'GET /scans': { items: [] },
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
  'GET /sources': { sources, canStoreTokens: true },
  ...over,
})

describe('a Dokploy source in settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it('warns that the key has full access, tests it and saves the source', async () => {
    let saved = false
    const api = mockApi(
      routes([coolifySource, githubSource], {
        'GET /sources': () => ({
          sources: saved
            ? [coolifySource, githubSource, dokploySource]
            : [coolifySource, githubSource],
          canStoreTokens: true,
        }),
        'POST /sources/test': (body: unknown) =>
          (body as { token: string }).token === KEY
            ? { ok: true, message: 'Connected to Dokploy v0.25.0, 2 projects visible' }
            : {
                ok: false,
                code: 'unauthorized',
                message: 'Dokploy answered 401 for project.all: the API key was rejected',
              },
        'POST /sources': () => {
          saved = true
          return reply(201, dokploySource)
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    // Not listed until one is added.
    await screen.findByText('Add source')
    expect(screen.queryByText('Dokploy')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.click(screen.getByRole('radio', { name: 'Dokploy' }))
    expect(screen.getByRole('note')).toHaveTextContent('A Dokploy API key has full access')

    const url = screen.getByLabelText('Instance URL')
    await user.type(url, 'https://dokploy.example.dev/')
    const key = screen.getByLabelText('API key')
    await user.type(key, 'wrong-key')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(key).toHaveAttribute('aria-invalid', 'true'))
    expect(key).toHaveAccessibleDescription(/the API key was rejected\./)

    await user.clear(key)
    await user.type(key, KEY)
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    expect(
      await screen.findByText(
        'dokploy.example.dev added. Connected to Dokploy v0.25.0, 2 projects visible.',
      ),
    ).toBeInTheDocument()
    expect(api.called('POST', '/sources')[0]?.body).toEqual({
      kind: 'dokploy',
      name: 'dokploy.example.dev',
      baseUrl: 'https://dokploy.example.dev',
      token: KEY,
    })
    expect(await screen.findByText('Dokploy, API key, full access')).toBeInTheDocument()
  })

  it('shows a saved Dokploy source with its deployments and the warning when replacing the key', async () => {
    mockApi(routes([coolifySource, githubSource, dokploySource]))
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    expect(await screen.findByText('Dokploy, API key, full access')).toBeInTheDocument()
    expect(screen.getByText('3 deployments')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Replace key' }))
    expect(screen.getByRole('note')).toHaveTextContent('A Dokploy API key has full access')
    expect(screen.getByLabelText('New API key')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Test and save key' })).toBeInTheDocument()
  })
})
