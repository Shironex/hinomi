import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, coolifySource, deployment, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// Settings, Sources: the manual deployment list.

const manualSource = {
  ...coolifySource,
  id: 7,
  kind: 'manual',
  name: 'Manual list',
  baseUrl: null,
  hasToken: false,
  deploymentCount: 1,
}
const entry = deployment({
  id: 70,
  name: 'partner-portal',
  source: { id: 7, kind: 'manual', name: 'Manual list' },
  gitRepository: 'example-org/portal',
  gitBranch: 'main',
  domains: ['https://portal.example.com'],
})

const routes = (sources: unknown[], items: unknown[] = []) => ({
  ...configuredRoutes(),
  'GET /sources': { sources, canStoreTokens: true },
  'GET /deployments': { items },
})

const region = async () => within(await screen.findByRole('region', { name: /^Sources$/ }))

describe('settings manual list', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('offers to create the list when there is none', async () => {
    const api = mockApi({
      ...routes([coolifySource]),
      'POST /sources': reply(201, manualSource),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    await user.click(await (await region()).findByRole('button', { name: 'Create list' }))
    await waitFor(() =>
      expect(api.called('POST', '/sources')[0]?.body).toEqual({
        kind: 'manual',
        name: 'Manual list',
      }),
    )
  })

  it('lists the entries and adds one with only the fields that were filled', async () => {
    const api = mockApi({
      ...routes([manualSource], [entry]),
      'POST /deployments': reply(201, { ...entry, id: 71, name: 'report-worker' }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await region()
    expect(await sources.findByText('partner-portal')).toBeInTheDocument()
    await user.click(sources.getByRole('button', { name: 'Add deployment' }))
    const form = within(sources.getByRole('form', { name: 'Add a deployment' }))
    await user.click(form.getByRole('button', { name: 'Add deployment' }))
    expect(form.getByText('Enter a name for the deployment.')).toBeVisible()
    await user.type(form.getByLabelText('Name'), 'report-worker')
    await user.type(form.getByLabelText('Repo'), 'example-org/worker')
    await user.type(form.getByLabelText('Domains'), 'https://w.example.com, w2.example.com')
    await user.click(form.getByRole('button', { name: 'Add deployment' }))
    await waitFor(() =>
      expect(api.called('POST', '/deployments')[0]?.body).toEqual({
        sourceId: 7,
        name: 'report-worker',
        domains: ['https://w.example.com', 'w2.example.com'],
        repo: 'example-org/worker',
      }),
    )
  })

  it('refuses a repo that is not owner/name before sending', async () => {
    const api = mockApi(routes([manualSource]))
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await region()
    await user.click(await sources.findByRole('button', { name: 'Add deployment' }))
    const form = within(sources.getByRole('form', { name: 'Add a deployment' }))
    await user.type(form.getByLabelText('Name'), 'x')
    await user.type(form.getByLabelText('Repo'), 'nope')
    await user.click(form.getByRole('button', { name: 'Add deployment' }))
    expect(await form.findByText('Must be owner/name.')).toBeVisible()
    expect(api.called('POST', '/deployments')).toHaveLength(0)
  })

  it('edits an entry, clearing what was emptied, and imports YAML', async () => {
    const api = mockApi({
      ...routes([manualSource], [entry]),
      'PATCH /deployments/70': reply(200, entry),
      'POST /deployments/import': reply(200, { created: 2, updated: 0, removed: 0 }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await region()
    await user.click(await sources.findByRole('button', { name: 'Edit partner-portal' }))
    const form = within(sources.getByRole('form', { name: 'Edit partner-portal' }))
    await user.clear(form.getByLabelText('Branch'))
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.called('PATCH', '/deployments/70')[0]?.body).toMatchObject({
        branch: null,
        repo: 'example-org/portal',
      }),
    )
    await user.click(await sources.findByRole('button', { name: 'Import YAML' }))
    await user.click(sources.getByRole('textbox', { name: /^YAML$/ }))
    await user.paste('deployments:\n  - name: a\n')
    await user.click(sources.getByRole('button', { name: 'Import' }))
    expect(await sources.findByText('Imported: 2 added, 0 updated, 0 removed.')).toBeVisible()
  })
})
