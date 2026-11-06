import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deploymentDetail,
  deploymentItem,
  findingsResponse,
  repoRef,
  apiError,
  mockViews,
} from '@/test/fixtures'
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

describe('deployments', () => {
  it('lists apps with coverage and shows the join on demand', async () => {
    mockViews({
      'GET /deployments': { items: [deploymentItem(), proxy, cron] },
      'GET /findings': findingsResponse([]),
      'GET /repos': { items: [repoRef(), repoRef({ id: 5, name: 'landing-2023' })] },
    })
    const user = userEvent.setup()
    await renderApp('/deployments')
    expect(await screen.findByRole('link', { name: 'storefront-web' })).toHaveAttribute(
      'href',
      '/deployments/1',
    )
    expect(screen.getByText('No repo matched')).toBeInTheDocument()
    expect(screen.getByLabelText('1 critical, 2 high, 9 moderate')).toBeInTheDocument()
    // The exposed count comes with the deployment; no findings query is needed for it.
    expect(screen.getByText('1 exposed')).toBeInTheDocument()
    expect(await screen.findByText('1 repo has no deployment')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show the join for image-proxy' }))
    const join = screen.getByRole('list', { name: /joins its repo/ })
    expect(within(join).getByText('Image only, the image scan covers it later')).toBeInTheDocument()
    // An image only service is not a missing mapping.
    expect(screen.getAllByText('No repo matched')).toHaveLength(1)
    expect(screen.getAllByText('Image only').length).toBeGreaterThan(0)
  })

  it('teaches how deployments arrive when there are none', async () => {
    mockViews({ 'GET /deployments': { items: [] }, 'GET /findings': findingsResponse([]) })
    await renderApp('/deployments')
    expect(await screen.findByText('No deployments yet')).toBeInTheDocument()
  })

  it('shows an error with a retry', async () => {
    mockViews({
      'GET /deployments': () => apiError(500, 'internal', 'Boom'),
      'GET /findings': findingsResponse([]),
    })
    await renderApp('/deployments')
    expect(await screen.findByRole('alert')).toHaveTextContent('Deployments did not load')
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
