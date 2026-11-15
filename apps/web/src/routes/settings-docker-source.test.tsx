import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, coolifySource, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// Settings, Sources: connecting a Docker host through a socket or a TLS endpoint.

const dockerSource = {
  ...coolifySource,
  id: 9,
  kind: 'docker' as const,
  name: 'edge-2',
  baseUrl: null,
  hasToken: false,
  deploymentCount: 3,
  docker: {
    transport: 'socket' as const,
    socketPath: '/run/docker-proxy/docker.sock',
    ca: null,
    cert: null,
    optIn: true,
  },
}

function routes(sources: unknown[] = [coolifySource]) {
  return { ...configuredRoutes(), 'GET /sources': { sources, canStoreTokens: true } }
}

async function sourcesRegion() {
  return within(await screen.findByRole('region', { name: 'Sources' }))
}

async function openDockerForm() {
  const user = userEvent.setup()
  await renderApp('/settings?sel=sources')
  const sources = await sourcesRegion()
  await user.click(await sources.findByRole('button', { name: 'Add source' }))
  const panel = within(sources.getByRole('group', { name: 'Add a source' }))
  await user.click(panel.getByRole('radio', { name: 'Docker host' }))
  return { user, sources, panel }
}

describe('docker source settings', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a connected Docker host and what it reads, without a token warning', async () => {
    mockApi(routes([coolifySource, dockerSource]))
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    const row = within((await sources.findByRole('heading', { name: 'edge-2' })).closest('li')!)
    expect(row.getByText('/run/docker-proxy/docker.sock')).toBeInTheDocument()
    expect(row.getByText('3 deployments')).toBeInTheDocument()
    expect(row.queryByText('No token')).not.toBeInTheDocument()
  })

  it('connects a socket, testing first, and shows the broad access warning', async () => {
    const api = mockApi({
      ...routes(),
      'POST /sources/test': {
        ok: true,
        message: 'Connected to Docker 27.3.1, 2 containers labelled hinomi.enable=true',
        warning: 'This connection allows more than Hinomi needs.',
      },
      'POST /sources': reply(201, { ...dockerSource, name: 'Docker' }),
    })
    const { user, sources, panel } = await openDockerForm()
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    expect(
      await sources.findByText(
        /Docker added\. Connected to Docker 27\.3\.1.*more than Hinomi needs/,
      ),
    ).toBeInTheDocument()
    const docker = { transport: 'socket', socketPath: '/var/run/docker.sock', optIn: true }
    expect(api.called('POST', '/sources/test')[0]?.body).toEqual({
      kind: 'docker',
      baseUrl: null,
      docker,
    })
    expect(api.called('POST', '/sources')[0]?.body).toEqual({
      kind: 'docker',
      name: 'Docker',
      baseUrl: null,
      docker,
    })
  })

  it('refuses plain http before sending anything', async () => {
    const api = mockApi(routes())
    const { user, panel } = await openDockerForm()
    await user.click(panel.getByRole('radio', { name: 'TLS endpoint' }))
    await user.type(panel.getByLabelText('Endpoint URL'), 'http://192.0.2.4:2375')
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    expect(await panel.findByText(/plain TCP without TLS is refused/)).toBeInTheDocument()
    expect(api.called('POST', '/sources/test')).toHaveLength(0)
  })

  it('shows a failed test by the form and saves nothing', async () => {
    const api = mockApi({
      ...routes(),
      'POST /sources/test': {
        ok: false,
        code: 'network',
        message: 'The Docker socket was not found at that path',
      },
    })
    const { user, panel } = await openDockerForm()
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    expect(
      await panel.findByText('The Docker socket was not found at that path.'),
    ).toBeInTheDocument()
    expect(api.called('POST', '/sources')).toHaveLength(0)
  })
})
