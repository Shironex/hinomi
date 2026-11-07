import type { RepoDetail } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockViews, repoDetail } from '@/test/fixtures'
import { apiError } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const withRelease = (over: Partial<RepoDetail['release']>): RepoDetail => {
  const base = repoDetail()
  return { ...base, release: { ...base.release, ...over } }
}

async function panel() {
  const heading = await screen.findByRole('heading', { name: 'Release' })
  return within(heading.closest('section') as HTMLElement)
}

describe('release panel', () => {
  it('shows the latest release, its installers, the tier and why', async () => {
    mockViews({ 'GET /repos/24': repoDetail() })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getByRole('link', { name: /v2\.3\.0/ })).toHaveAttribute(
      'href',
      'https://github.com/kestrel-co/kestrel-desk/releases/tag/v2.3.0',
    )
    expect(p.getByText('27 Oct 2026')).toBeInTheDocument()
    expect(p.getByText('Has installers')).toBeInTheDocument()
    expect(p.getByText('Kestrel-Setup-2.3.0.exe')).toBeInTheDocument()
    expect(p.getByText('In the released tier')).toBeInTheDocument()
    expect(p.getByText(/is in the hands of users/)).toBeInTheDocument()
    expect(p.getByText('2 open advisories in v2.3.0')).toBeInTheDocument()
    expect(p.getByText('1 of them: fixed on main, not released yet')).toBeInTheDocument()
    expect(p.getByRole('link', { name: 'See them in All alerts' })).toHaveAttribute(
      'href',
      expect.stringContaining('/alerts'),
    )
    expect(p.getByRole('radio', { name: 'Automatic' })).toBeChecked()
  })

  it('does not talk about account repos', async () => {
    mockViews({ 'GET /repos/24': repoDetail() })
    await renderApp('/repos/24')
    await panel()
    expect(screen.queryByText(/account repos/i)).not.toBeInTheDocument()
  })

  it('explains a library release that has no installers', async () => {
    mockViews({
      'GET /repos/24': withRelease({
        status: 'no_installers',
        installers: false,
        installerAssets: [],
        openFindings: 0,
        fixedOnDefaultBranch: 0,
      }),
    })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getByText('Not in the released tier')).toBeInTheDocument()
    expect(p.getByText(/No installer files/)).toBeInTheDocument()
    expect(p.getByText(/reads as a library/)).toBeInTheDocument()
    expect(p.getByText('Nothing scanned at a release tag')).toBeInTheDocument()
  })

  it('says a deployed repo keeps its deploy tiers', async () => {
    mockViews({
      'GET /repos/24': withRelease({
        status: 'deployed',
        latestTag: null,
        latestAt: null,
        installers: null,
        installerAssets: [],
        checkedAt: null,
        openFindings: 0,
        fixedOnDefaultBranch: 0,
      }),
    })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getByText(/keeps? their deploy tiers|keep their deploy tiers/)).toBeInTheDocument()
    expect(p.getByText('No final release on GitHub')).toBeInTheDocument()
  })

  it('says a repo the daily check has not reached is not checked yet', async () => {
    mockViews({
      'GET /repos/24': withRelease({
        status: 'not_checked',
        latestTag: null,
        latestAt: null,
        installers: null,
        installerAssets: [],
        checkedAt: null,
        openFindings: 0,
        fixedOnDefaultBranch: 0,
      }),
    })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getAllByText('Not checked yet').length).toBeGreaterThan(1)
  })

  it('warns when the tag has no lockfile', async () => {
    mockViews({ 'GET /repos/24': withRelease({ lockfileMissing: true }) })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getByText('No lockfile at this tag')).toBeInTheDocument()
  })

  it('sets the tier through the API and refreshes the repo', async () => {
    let tier: 'auto' | 'on' | 'off' = 'auto'
    const api = mockViews({
      'GET /repos/24': () =>
        tier === 'off'
          ? withRelease({ tier, status: 'turned_off', openFindings: 0, fixedOnDefaultBranch: 0 })
          : withRelease({ tier }),
      'PUT /repos/24/release-tier': (body: unknown) => {
        tier = (body as { tier: 'auto' | 'on' | 'off' }).tier
        return withRelease({ tier, status: 'turned_off', openFindings: 0, fixedOnDefaultBranch: 0 })
      },
    })
    const user = userEvent.setup()
    await renderApp('/repos/24')
    const p = await panel()
    await user.click(p.getByRole('radio', { name: 'Never' }))
    await waitFor(() =>
      expect(api.called('PUT', '/repos/24/release-tier')[0]?.body).toEqual({ tier: 'off' }),
    )
    expect(
      await p.findByText('The tier is set to Never for this repo, so no release is scanned.'),
    ).toBeInTheDocument()
    expect(p.getByRole('radio', { name: 'Never' })).toBeChecked()
    // The repo detail was read again after the write.
    expect(api.called('GET', '/repos/24').length).toBeGreaterThan(1)
  })

  it('does not call the API when the current mode is picked again', async () => {
    const api = mockViews({ 'GET /repos/24': repoDetail() })
    const user = userEvent.setup()
    await renderApp('/repos/24')
    const p = await panel()
    await user.click(p.getByRole('radio', { name: 'Automatic' }))
    expect(api.called('PUT', '/repos/24/release-tier')).toHaveLength(0)
  })

  it('reports a failed save and keeps the saved mode', async () => {
    mockViews({
      'GET /repos/24': repoDetail(),
      'PUT /repos/24/release-tier': apiError(500, 'internal', 'The database is busy'),
    })
    const user = userEvent.setup()
    await renderApp('/repos/24')
    const p = await panel()
    await user.click(p.getByRole('radio', { name: 'Always' }))
    expect(await p.findByRole('alert')).toHaveTextContent('The tier did not save')
    expect(p.getByRole('radio', { name: 'Automatic' })).toBeChecked()
  })

  it('shows a page for an unknown repo', async () => {
    mockViews({ 'GET /repos/99': apiError(404, 'not_found', 'No such repo') })
    await renderApp('/repos/99')
    expect(await screen.findByText('This repo is not known yet')).toBeInTheDocument()
  })
})
