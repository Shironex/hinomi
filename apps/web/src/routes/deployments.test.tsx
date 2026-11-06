import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deploymentDetail, deploymentItem, repoRef, apiError, mockViews } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const proxy = deploymentItem({
  id: 6,
  name: 'image-proxy',
  kind: 'service',
  image: 'registry.example.dev/imgproxy:3.21',
  gitRepository: null,
  gitBranch: null,
  mapping: 'none',
  repos: [],
  coverage: { alerts: 'none', blindSpots: [], covered: false, imageOnly: true },
  openFindings: { critical: 0, high: 0, moderate: 0, low: 0 },
  exposed: 0,
  openBlindSpots: 0,
})

const cron = deploymentItem({
  id: 7,
  name: 'legacy-cron',
  kind: 'application',
  domains: [],
  reach: 'internal',
  gitRepository: 'git@git.example.dev:legacy',
  gitBranch: 'main',
  mapping: 'none',
  repos: [],
  coverage: { alerts: 'none', blindSpots: ['no_repo_mapping'], covered: false, imageOnly: false },
  openFindings: { critical: 0, high: 0, moderate: 0, low: 0 },
  exposed: 0,
  openBlindSpots: 1,
})

/** The test setup answers every media query with false (a phone); this makes width queries match. */
function screenWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

const media = deploymentItem({
  id: 2,
  name: 'media-api',
  server: 'edge-2',
  domains: ['https://media.example.dev'],
  exposed: 64,
  openFindings: { critical: 4, high: 60, moderate: 0, low: 0 },
  coverage: {
    alerts: 'enabled',
    blindSpots: ['lockfile_missing'],
    covered: false,
    imageOnly: false,
  },
  openBlindSpots: 1,
})

const stopped = deploymentItem({
  id: 3,
  name: 'cron-runner',
  server: 'core-1',
  domains: [],
  reach: 'internal',
  status: 'exited:0',
  exposed: 0,
  openFindings: { critical: 0, high: 0, moderate: 2, low: 0 },
})

const fleet = [deploymentItem(), media, stopped, proxy, cron]

describe('deployments on a phone', () => {
  it('turns the map into a list grouped by server, each app linking to its detail', async () => {
    mockViews({
      'GET /deployments': { items: fleet },
      'GET /repos': { items: [repoRef(), repoRef({ id: 5, name: 'landing-2023' })] },
    })
    await renderApp('/deployments')
    const list = await screen.findByRole('list', { name: 'Deployments' })
    expect(within(list).getByText('edge-2')).toBeInTheDocument()
    expect(within(list).getByText('core-1')).toBeInTheDocument()
    const storefront = within(list).getByRole('link', { name: /storefront-web/ })
    expect(storefront).toHaveAttribute('href', '/deployments?sel=1')
    expect(within(list).getByText('No repo')).toBeInTheDocument()
    expect(within(list).getByText('Stopped')).toBeInTheDocument()
    expect(within(list).getByText('Image only')).toBeInTheDocument()
    expect(within(list).getByRole('img', { name: 'Blind spot' })).toBeInTheDocument()
    // No map on a phone, only the two list orders.
    expect(screen.queryByRole('link', { name: 'Map' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'By exposure' })).toBeInTheDocument()
  })

  it('opens an app as its own page with the join and back to the list', async () => {
    mockViews({
      'GET /deployments': { items: fleet },
      'GET /deployments/6': deploymentDetail({ ...proxy, watchPaths: null, findings: [] }),
    })
    await renderApp('/deployments?sel=6')
    expect(
      await screen.findByRole('heading', { level: 2, name: 'image-proxy' }),
    ).toBeInTheDocument()
    const join = screen.getByRole('list', { name: /joins its repo/ })
    expect(within(join).getByText('Image only, the image scan covers it later')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the list' })).toBeInTheDocument()
  })

  it('teaches how deployments arrive when there are none', async () => {
    mockViews({ 'GET /deployments': { items: [] } })
    await renderApp('/deployments')
    expect(await screen.findByText('No deployments yet')).toBeInTheDocument()
  })

  it('shows an error with a retry', async () => {
    mockViews({ 'GET /deployments': () => apiError(500, 'internal', 'Boom') })
    await renderApp('/deployments')
    expect(await screen.findByRole('alert')).toHaveTextContent('Deployments did not load')
  })
})

describe('deployments map', () => {
  beforeEach(() => screenWidth(true))

  it('draws apps as tiles grouped by server, with the legend and every mark', async () => {
    mockViews({
      'GET /deployments': { items: fleet },
      'GET /repos': { items: [repoRef(), repoRef({ id: 5, name: 'landing-2023' })] },
    })
    await renderApp('/deployments')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Deployments' }),
    ).toBeInTheDocument()
    expect(screen.getByText('5 apps on 3 servers')).toBeInTheDocument()
    const legend = screen.getByRole('list', { name: 'Map legend' })
    expect(within(legend).getByText('60 or more exposed')).toBeInTheDocument()
    expect(within(legend).getByText('Blind spot')).toBeInTheDocument()

    // Public servers first, the hotter one leading; internal ones after.
    const servers = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(servers).toEqual([
      'edge-2public edge, 1 app',
      'edge-1public edge, 3 apps',
      'core-1internal network, 1 app',
    ])
    const edge2 = screen.getByRole('region', { name: 'edge-2' })
    const tile = within(edge2).getByRole('link', { name: /media-api/ })
    expect(tile).toHaveAttribute('href', '/deployments?sel=2')
    expect(within(tile).getByText('64')).toBeInTheDocument()
    expect(within(tile).getByText('4 critical')).toBeInTheDocument()
    expect(within(tile).getByText('Blind spot')).toBeInTheDocument()
    expect(tile.className).toContain('--heat-3')

    const edge1 = screen.getByRole('region', { name: 'edge-1' })
    expect(within(edge1).getByRole('link', { name: /legacy-cron/ })).toHaveTextContent(
      'Unknownno repo mapped',
    )
    expect(within(edge1).getByRole('link', { name: /image-proxy/ })).toHaveTextContent('Image only')
    expect(screen.getByRole('link', { name: /cron-runner/ })).toHaveTextContent('findings, stopped')
    expect(await screen.findByText('1 repo has no deployment')).toBeInTheDocument()
  })

  it('opens a tile in the split pane and leaves it with Esc', async () => {
    mockViews({ 'GET /deployments': { items: fleet }, 'GET /deployments/1': deploymentDetail() })
    const user = userEvent.setup()
    const { router } = await renderApp('/deployments')
    await user.click(await screen.findByRole('link', { name: /storefront-web/ }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'storefront-web' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Deployments' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Deployments' })
    expect(within(list).getByRole('link', { name: /storefront-web/ })).toHaveAttribute(
      'aria-current',
    )
    expect(within(list).getByRole('link', { name: /media-api/ })).not.toHaveAttribute(
      'aria-current',
    )
    expect(screen.getByRole('link', { name: 'By server' })).toHaveAttribute('aria-current', 'page')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(await screen.findByRole('list', { name: 'Map legend' })).toBeInTheDocument()
  })

  it('ranks the list by exposure across servers', async () => {
    mockViews({
      'GET /deployments': { items: fleet },
      'GET /deployments/2': deploymentDetail(media),
    })
    await renderApp('/deployments?order=exposure')
    const list = await screen.findByRole('list', { name: 'Deployments' })
    const names = within(list)
      .getAllByRole('link')
      .map((a) => a.textContent ?? '')
    expect(names[0]).toContain('media-api')
    expect(names[1]).toContain('storefront-web')
    // Ranked, so no server headings.
    expect(within(list).queryByText('edge-1')).not.toBeInTheDocument()
  })
})

describe('deployment detail', () => {
  it('shows the join, exposed findings and coverage', async () => {
    mockViews({ 'GET /deployments/1': deploymentDetail() })
    await renderApp('/deployments/1')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'storefront-web' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'shop.example.dev' })).toHaveAttribute(
      'href',
      'https://shop.example.dev',
    )
    expect(screen.getByText('1 exposed or blind spot')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See in All alerts/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/alerts?deployment='),
    )
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'storefront-web',
    )
  })

  it('shows the bumps that clear the most exposed findings here', async () => {
    mockViews({ 'GET /deployments/1': deploymentDetail() })
    await renderApp('/deployments/1')
    const bumps = await screen.findByRole('region', { name: 'Bumps that clear the most here' })
    expect(within(bumps).getByText('14.2.9')).toBeInTheDocument()
    expect(within(bumps).getByText('finding cleared')).toBeInTheDocument()
  })

  it('lists recent deploys and their commits from Coolify', async () => {
    mockViews({
      'GET /deployments/1': deploymentDetail(),
      'GET /deployments/1/deploys': {
        available: true,
        reason: null,
        items: [
          {
            id: 'dpl-0002',
            status: 'finished',
            commit: 'b1c2d3e4f5a6b7c8d9e0',
            commitMessage: 'fix: escape the search box\n\nlonger body',
            startedAt: '2026-11-05T09:00:00.000Z',
            finishedAt: '2026-11-05T09:03:00.000Z',
            webhook: true,
            rollback: false,
          },
          {
            id: 'dpl-0001',
            status: 'failed',
            commit: null,
            commitMessage: null,
            startedAt: '2026-11-04T08:00:00.000Z',
            finishedAt: null,
            webhook: false,
            rollback: false,
          },
        ],
      },
    })
    await renderApp('/deployments/1')
    const feed = await screen.findByRole('list', { name: 'Recent deploys' })
    expect(within(feed).getByRole('link', { name: 'b1c2d3e' })).toHaveAttribute(
      'href',
      'https://github.com/kestrel-co/storefront/commit/b1c2d3e4f5a6b7c8d9e0',
    )
    expect(within(feed).getByText('fix: escape the search box')).toBeInTheDocument()
    expect(within(feed).getByText('Failed')).toBeInTheDocument()
  })

  it('says why deploys are not available', async () => {
    mockViews({
      'GET /deployments/1': deploymentDetail(),
      'GET /deployments/1/deploys': {
        available: false,
        reason: 'Coolify answered 401 for /deployments/applications/app-1: the token was rejected',
        items: [],
      },
    })
    await renderApp('/deployments/1')
    expect(await screen.findByText(/the token was rejected/)).toBeInTheDocument()
  })

  it('shows overrides and sends edits to Settings', async () => {
    const override = {
      repo: repoRef({ id: 8, name: 'imgproxy-config' }),
      note: 'Built from config repo',
      createdAt: '2026-11-01T10:00:00.000Z',
    }
    mockViews({
      'GET /deployments/6': deploymentDetail({
        ...proxy,
        mapping: 'override',
        repos: [override.repo],
        overrides: [override],
        watchPaths: null,
        findings: [],
      }),
    })
    await renderApp('/deployments/6')
    const list = await screen.findByRole('list', { name: 'Repo overrides' })
    expect(within(list).getByText('kestrel-co/imgproxy-config')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Edit mapping in Settings/ })).toHaveAttribute(
      'href',
      '/settings#settings-mapping',
    )
  })

  it('links an unmapped app to the repo mapping in Settings', async () => {
    mockViews({
      'GET /deployments/7': deploymentDetail({ ...cron, watchPaths: null, findings: [] }),
    })
    await renderApp('/deployments/7')
    expect(await screen.findByText('No repo matched', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('git@git.example.dev:legacy')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings, Repo mapping' })).toHaveAttribute(
      'href',
      '/settings#settings-mapping',
    )
    expect(screen.getByRole('link', { name: /Map a repo in Settings/ })).toBeInTheDocument()
  })

  it('explains an image only service instead of asking for a repo', async () => {
    mockViews({
      'GET /deployments/6': deploymentDetail({ ...proxy, watchPaths: null, findings: [] }),
    })
    await renderApp('/deployments/6')
    expect(
      await screen.findByText('Runs an image with no git source', { selector: 'b' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No repo matched', { selector: 'b' })).not.toBeInTheDocument()
    expect(screen.getByText('Phase 2 (not yet)')).toBeInTheDocument()
  })

  it('says when the deployment is unknown', async () => {
    mockViews({ 'GET /deployments/42': () => apiError(404, 'not_found', 'Deployment not found') })
    await renderApp('/deployments/42')
    expect(await screen.findByText('This deployment is not known yet')).toBeInTheDocument()
  })
})
