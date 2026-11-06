import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTheme } from '@/lib/theme'
import { configuredRoutes, mockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

describe('routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setTheme('system')
  })

  it.each([
    ['/', 'Exposure'],
    ['/alerts', 'All alerts'],
    ['/finding/F1', 'Finding F1'],
    ['/deployments', 'Deployments'],
    ['/deployments/storefront-web', 'storefront-web'],
    ['/fix-runs', 'Fix runs'],
    ['/drift', 'Drift guards'],
    ['/settings', 'Settings'],
    ['/onboarding', 'Find what is exposed, not just what is vulnerable'],
    ['/no-such-page', 'Page not found'],
  ])('%s renders its page inside the shell', async (path, heading) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok' }))),
    )
    await renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0)
  })

  it('marks the list view current on a detail route', async () => {
    await renderApp('/deployments/storefront-web')
    const rail = screen.getByRole('complementary', { name: 'Rail' })
    expect(within(rail).getByRole('link', { name: 'Deploys' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('shows the rail counts, the scan status and Scan now in the shell', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /shell/nav-counts': {
        needsAction: 267,
        deployments: 12,
        alerts: 4917,
        activeFixRuns: 3,
      },
    })
    await renderApp('/settings')
    const rail = screen.getByRole('complementary', { name: 'Rail' })
    expect(await within(rail).findByText('267')).toBeInTheDocument()
    expect(within(rail).getByText('need action', { exact: false })).toBeInTheDocument()
    expect(within(rail).getByRole('link', { name: /Fixes/ })).toHaveTextContent('3')
    expect(within(rail).getByRole('link', { name: 'Alerts' })).toHaveAttribute(
      'title',
      'All alerts, 4,917',
    )
    const topBar = within(screen.getByRole('banner'))
    expect(await topBar.findByText(/^Scanned /)).toBeInTheDocument()
    expect(topBar.getByRole('button', { name: 'Scan now' })).toBeEnabled()
  })

  it('opens all keys from the key hint bar', async () => {
    // Settings is a split view; from 1100 px its detail pane holds the key bar.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const user = userEvent.setup()
    await renderApp('/settings')
    await user.click(screen.getByRole('button', { name: /all keys/ }))
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('shows the API health from /api/health on settings', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ status: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)
    await renderApp('/settings?sel=access')
    expect(await screen.findByText('Healthy')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('shows an error with a retry when the server is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    await renderApp('/settings')
    expect(await screen.findByRole('alert')).toHaveTextContent('Server not reachable')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('navigates with g then a letter and opens the shortcuts dialog with ?', async () => {
    const user = userEvent.setup()
    const { router } = await renderApp('/')
    await user.keyboard('gd')
    await waitFor(() => expect(router.state.location.pathname).toBe('/deployments'))

    await user.keyboard('?')
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dialog).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('focuses the alert search with /', async () => {
    const user = userEvent.setup()
    const { router } = await renderApp('/')
    await user.keyboard('/')
    await waitFor(() => expect(router.state.location.pathname).toBe('/alerts'))
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Search alerts' })).toHaveFocus(),
    )
    // Typing in the field must not trigger shortcuts.
    await user.keyboard('gd')
    expect(router.state.location.pathname).toBe('/alerts')
  })

  it('toggles the theme with t', async () => {
    const user = userEvent.setup()
    await renderApp('/')
    await act(() => user.keyboard('t'))
    await act(() => user.keyboard('t'))
    expect(document.documentElement).toHaveClass('dark')
  })

  it('loads a lazy route on navigation and keeps its search validation and static data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok' }))),
    )
    const { router } = await renderApp('/settings')
    await screen.findByRole('heading', { level: 1, name: 'Settings' })

    await act(() => router.navigate({ to: '/alerts', search: { q: 'redis' } }))
    expect(await screen.findByRole('searchbox', { name: 'Search alerts' })).toHaveValue('redis')
    expect(router.state.location.search).toMatchObject({ q: 'redis' })
    expect(router.state.matches.at(-1)?.staticData).toMatchObject({ crumb: 'All alerts' })
  })
})
