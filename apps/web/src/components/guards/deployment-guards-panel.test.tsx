import type { DeploymentGuard } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploymentDetail, findingGuard, mockViews, repoRef } from '@/test/fixtures'
import { reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const guards: DeploymentGuard[] = [
  {
    check: 'docker_socket',
    result: 'pass',
    evidence: { check: 'docker_socket', mounts: [], checked: ['compose'], reason: null },
    findingId: null,
    override: null,
  },
  {
    check: 'shared_network',
    result: 'unknown',
    evidence: {
      check: 'shared_network',
      basis: null,
      network: null,
      destination: null,
      project: null,
      peers: [],
      reason: 'This source does not report which networks the container is on.',
    },
    findingId: 41,
    override: null,
  },
  {
    check: 'root_user',
    result: 'fail',
    evidence: findingGuard().evidence,
    findingId: 30,
    override: null,
  },
  {
    check: 'watch_paths_skip',
    result: 'warn',
    evidence: {
      check: 'watch_paths_skip',
      autoDeploy: true,
      patterns: ['src/**'],
      checked: ['Dockerfile', 'src/main.ts'],
      skipped: ['Dockerfile'],
      reason: null,
    },
    findingId: 42,
    override: {
      id: 2,
      scope: 'repo',
      reason: 'Deployed by hand after each release',
      createdAt: '2026-11-01T09:00:00.000Z',
    },
  },
  { check: 'framework_support', result: null, evidence: null, findingId: null, override: null },
]

async function guardsPanel() {
  const heading = await screen.findByRole('heading', { name: 'Guards' })
  return within(heading.closest('section') as HTMLElement)
}

describe('deployment guards panel', () => {
  it('lists every check worst first, pass, unknown and not run included', async () => {
    mockViews({ 'GET /deployments/1': deploymentDetail({ guards }) })
    await renderApp('/deployments/1')
    const panel = await guardsPanel()
    const rows = within(panel.getByRole('list', { name: 'Guards' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Container runs as root.*Fail/),
      expect.stringMatching(/^Watch paths skip.*Warn/),
      expect.stringMatching(/^Shares a network.*Unknown.*does not report which networks/),
      expect.stringMatching(/^Docker socket mounted.*Pass/),
      expect.stringMatching(/^Framework.*Not run.*No scan has run this check here yet/),
    ])
    expect(panel.getByText('1 failing')).toBeInTheDocument()
    expect(panel.getByRole('link', { name: 'Container runs as root' })).toHaveAttribute(
      'href',
      '/finding/30',
    )
    expect(
      panel.getByText('Turned off for the repo, 1 Nov 2026:', { exact: false }),
    ).toBeInTheDocument()
    expect(panel.getByText('Deployed by hand after each release')).toBeInTheDocument()
    expect(
      panel.queryByRole('button', { name: /Turn off Docker socket mounted/ }),
    ).not.toBeInTheDocument()
  })

  it('turns a check off for this deployment from its row', async () => {
    const api = mockViews({
      'GET /deployments/1': deploymentDetail({ guards }),
      'POST /overrides': reply(201, {
        id: 7,
        check: 'root_user',
        deployment: { id: 1, name: 'storefront-web' },
        repo: null,
        reason: 'Vendor image',
        createdAt: '2026-11-05T10:00:00.000Z',
        updatedAt: '2026-11-05T10:00:00.000Z',
      }),
    })
    const user = userEvent.setup()
    await renderApp('/deployments/1')
    const panel = await guardsPanel()
    await user.click(
      panel.getByRole('button', { name: 'Turn off Container runs as root for this deployment' }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('radio', { name: /The whole repo, kestrel-co\/storefront/ }),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), 'Vendor image')
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    await waitFor(() =>
      expect(api.called('POST', '/overrides')[0]?.body).toEqual({
        check: 'root_user',
        deploymentId: 1,
        reason: 'Vendor image',
      }),
    )
  })

  it('stays hidden while no check has run', async () => {
    mockViews({ 'GET /deployments/1': deploymentDetail({ repos: [repoRef()] }) })
    await renderApp('/deployments/1')
    await screen.findByRole('heading', { level: 1, name: 'storefront-web' })
    expect(screen.queryByRole('heading', { name: 'Guards' })).not.toBeInTheDocument()
  })
})
