import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const base = { forwarded: false }

async function accessSection() {
  return within(await screen.findByRole('region', { name: 'Access' }))
}

describe('access status', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows Tailscale with the login instead of the warning', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'tailscale',
        ...base,
        address: '127.0.0.1',
        via: 'serve',
        login: 'ops@example.dev',
      },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText('Protected by Tailscale as ops@example.dev')).toBeVisible()
    expect(access.queryByText('Hinomi has no login yet')).not.toBeInTheDocument()
    expect(access.getByRole('link', { name: /How Hinomi detects this/ })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/access.md'),
    )
    const topBar = within(screen.getByRole('banner'))
    expect(topBar.getByRole('link', { name: 'Protected by Tailscale' })).toHaveAttribute(
      'href',
      '/settings?sel=access',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the tailnet address when Tailscale is detected by address', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'tailscale',
        ...base,
        address: '100.100.7.8',
        via: 'address',
        login: null,
      },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText('Protected by Tailscale')).toBeVisible()
    expect(access.getByText('100.100.7.8')).toBeInTheDocument()
  })

  it('shows a verified Cloudflare Access login', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'cloudflare_access',
        ...base,
        address: '172.18.0.4',
        verified: true,
        unverifiedReason: null,
        email: 'ops@example.dev',
      },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(
      await access.findByText('Protected by Cloudflare Access as ops@example.dev'),
    ).toBeVisible()
  })

  it('keeps a warning for a Cloudflare Access header it could not verify', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'cloudflare_access',
        ...base,
        address: '172.18.0.4',
        verified: false,
        unverifiedReason: 'not_configured',
        email: null,
      },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText('Cloudflare Access header seen, not verified')).toBeVisible()
    expect(access.getByText('HINOMI_CF_ACCESS_TEAM_DOMAIN')).toBeInTheDocument()
  })

  it('turns red on a public address, on the page and in the shell', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': { state: 'public', ...base, address: '203.0.113.9' },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText('Hinomi is reachable from the internet')).toBeVisible()
    expect(access.getByText('203.0.113.9')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Reachable from the internet.')
    const topBar = within(screen.getByRole('banner'))
    expect(topBar.getByRole('link', { name: 'Public, no protection' })).toBeInTheDocument()
  })

  it('keeps the warning and names the address when it cannot tell', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /access': {
        state: 'unknown',
        ...base,
        address: '172.18.0.1',
        reason: 'private_address',
      },
    })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText(/a private or container address/)).toBeVisible()
    expect(access.getByText('Hinomi has no login yet')).toBeVisible()
    const topBar = within(screen.getByRole('banner'))
    expect(topBar.getByRole('link', { name: 'Access not detected' })).toBeInTheDocument()
  })

  it('keeps the plain warning when the server cannot be asked', async () => {
    mockApi({ ...configuredRoutes(), 'GET /access': reply(500) })
    await renderApp('/settings?sel=access')
    const access = await accessSection()
    expect(await access.findByText('Hinomi has no login yet')).toBeVisible()
  })

  it('replaces the onboarding warning too', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /shell/scan-status': { state: 'unconfigured' },
      'GET /sources': { sources: [], canStoreTokens: true },
      'GET /onboarding': { finished: false, alertsSkipped: false },
      'GET /access': {
        state: 'tailscale',
        ...base,
        address: '100.100.7.8',
        via: 'address',
        login: null,
      },
    })
    await renderApp('/onboarding')
    const main = within(screen.getByRole('main'))
    expect(await main.findByText('Protected by Tailscale')).toBeVisible()
    expect(
      main.queryByText('Put this behind Tailscale or Cloudflare Access first'),
    ).not.toBeInTheDocument()
  })
})
