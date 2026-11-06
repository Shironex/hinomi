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
  coverage: { alerts: 'none', blindSpots: ['no_repo_mapping'], covered: false },
  openFindings: { critical: 0, high: 0, moderate: 0, low: 0 },
  exposed: 0,
  openBlindSpots: 1,
})

describe('deployments', () => {
  it('lists apps with coverage and shows the join on demand', async () => {
    mockViews({
      'GET /deployments': { items: [deploymentItem(), proxy] },
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
    expect(await screen.findByText('1 repo has no deployment')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show the join for image-proxy' }))
    const join = screen.getByRole('list', { name: /joins its repo/ })
    expect(within(join).getByText('Registry image, no source')).toBeInTheDocument()
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
      'GET /deployments/6': deploymentDetail({ ...proxy, watchPaths: null, findings: [] }),
    })
    await renderApp('/deployments/6')
    expect(await screen.findByText('No repo matched', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings, Repo mapping' })).toHaveAttribute(
      'href',
      '/settings#settings-mapping',
    )
    expect(screen.getByRole('link', { name: /Map a repo in Settings/ })).toBeInTheDocument()
  })

  it('says when the deployment is unknown', async () => {
    mockViews({ 'GET /deployments/42': () => apiError(404, 'not_found', 'Deployment not found') })
    await renderApp('/deployments/42')
    expect(await screen.findByText('This deployment is not known yet')).toBeInTheDocument()
  })
})
