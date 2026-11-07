import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, mockApi, reply, versionInfo } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const update = {
  version: '0.3.1',
  url: 'https://github.com/Shironex/hinomi/releases/tag/v0.3.1',
  imageTag: 'ghcr.io/shironex/hinomi:0.3.1',
}

const settings = (updateCheckEnabled: boolean) => ({
  scanIntervalMinutes: 360,
  osvEnabled: true,
  includeAccountRepos: false,
  updateCheckEnabled,
  supportWindowDays: 90,
  imageScan: 'off',
})

async function aboutRegion() {
  return within(await screen.findByRole('region', { name: 'About' }))
}

describe('the running version in the rail', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the version, with the build commit in the tooltip', async () => {
    mockApi(configuredRoutes())
    await renderApp('/')
    const rail = within(screen.getByRole('complementary', { name: 'Rail' }))
    const label = await rail.findByText('v0.3.0')
    expect(label).toHaveAttribute('title', 'Hinomi v0.3.0, build 3f9a1c7')
    expect(rail.queryByText(/available/)).not.toBeInTheDocument()
  })

  it('says dev with the short sha for a build that is not a release', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /version': versionInfo({
        version: 'dev',
        isDev: true,
        imageTag: null,
        releaseNotesUrl: null,
      }),
    })
    await renderApp('/')
    const rail = within(screen.getByRole('complementary', { name: 'Rail' }))
    expect(await rail.findByText('dev 3f9a1c7')).toBeInTheDocument()
  })

  it('links the release notes of a newer release', async () => {
    mockApi({ ...configuredRoutes(), 'GET /version': versionInfo({ update }) })
    await renderApp('/')
    const rail = within(screen.getByRole('complementary', { name: 'Rail' }))
    const link = await rail.findByRole('link', { name: 'v0.3.1 available' })
    expect(link).toHaveAttribute('href', update.url)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('shows nothing, and no error, when the version cannot be read', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /version': reply(500, { error: { code: 'internal' } }),
    })
    await renderApp('/')
    const rail = within(screen.getByRole('complementary', { name: 'Rail' }))
    await waitFor(() => expect(api.called('GET', '/version').length).toBeGreaterThan(0))
    expect(rail.queryByText(/^v\d/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('settings, about', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the version, commit, build date, notes link and image', async () => {
    mockApi(configuredRoutes())
    await renderApp('/settings?sel=about')
    const about = await aboutRegion()
    expect(await about.findByText('3f9a1c7')).toBeInTheDocument()
    expect(about.getAllByText('v0.3.0').length).toBeGreaterThan(0)
    expect(about.getByText('7 Nov 2026')).toBeInTheDocument()
    expect(about.getByRole('link', { name: 'v0.3.0' })).toHaveAttribute(
      'href',
      'https://github.com/Shironex/hinomi/releases/tag/v0.3.0',
    )
    expect(about.getByText('ghcr.io/shironex/hinomi:0.3.0')).toBeInTheDocument()
    expect(about.queryByText(/available/)).not.toBeInTheDocument()
  })

  it('shows a dev build without a notes link or image tag', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /version': versionInfo({
        version: 'dev',
        isDev: true,
        commit: null,
        buildDate: null,
        imageTag: null,
        releaseNotesUrl: null,
      }),
    })
    await renderApp('/settings?sel=about')
    const about = await aboutRegion()
    expect(await about.findByText('A dev build has none')).toBeInTheDocument()
    expect(about.getByText('Built locally')).toBeInTheDocument()
    expect(about.getByText('dev')).toBeInTheDocument()
  })

  it('names a newer release with the upgrade line', async () => {
    mockApi({ ...configuredRoutes(), 'GET /version': versionInfo({ update }) })
    await renderApp('/settings?sel=about')
    const about = await aboutRegion()
    expect(await about.findByText('v0.3.1 available')).toBeInTheDocument()
    expect(about.getByText('HINOMI_VERSION=0.3.1 docker compose up -d')).toBeInTheDocument()
    expect(about.getByText('ghcr.io/shironex/hinomi:0.3.1')).toBeInTheDocument()
  })

  it('turns the update check off and on', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'PATCH /settings': (body: unknown) =>
        settings((body as { updateCheckEnabled: boolean }).updateCheckEnabled),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=about')
    const about = await aboutRegion()
    const toggle = await about.findByRole('switch', { name: 'Check for new releases' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(api.called('PATCH', '/settings')[0]?.body).toEqual({ updateCheckEnabled: false })
    await user.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(api.called('PATCH', '/settings')[1]?.body).toEqual({ updateCheckEnabled: true })
  })

  it('summarises the build in the settings list', async () => {
    mockApi({ ...configuredRoutes(), 'GET /version': versionInfo({ update }) })
    await renderApp('/settings')
    const list = within(await screen.findByRole('list', { name: 'Settings sections' }))
    expect(await list.findByText('v0.3.0, v0.3.1 available')).toBeInTheDocument()
  })
})
