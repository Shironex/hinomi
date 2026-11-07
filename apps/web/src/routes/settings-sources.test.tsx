import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, coolifySource, githubSource, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

// Settings, Sources after setup: several GitHub sources, what each holds, adding and removing.

const orgApp = {
  ...githubSource,
  id: 2,
  name: 'kestrel-co',
  auth: 'github_app' as const,
  appId: '1048576',
  installationId: '52428800',
  repoCount: 12,
}
const personal = { ...githubSource, id: 3, name: 'mara-kestrel', repoCount: 1 }

function routes(sources: unknown[] = [{ ...coolifySource, deploymentCount: 4 }, orgApp, personal]) {
  return { ...configuredRoutes(), 'GET /sources': { sources, canStoreTokens: true } }
}

async function sourcesRegion() {
  return within(await screen.findByRole('region', { name: 'Sources' }))
}

describe('settings sources', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows what each source holds', async () => {
    mockApi(routes())
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    const row = async (name: string) =>
      within((await sources.findByRole('heading', { name })).closest('li')!)
    expect((await row('coolify.example.dev')).getByText('4 deployments')).toBeInTheDocument()
    expect((await row('kestrel-co')).getByText('12 repos')).toBeInTheDocument()
    expect((await row('mara-kestrel')).getByText('1 repo')).toBeInTheDocument()
  })

  it('adds a second GitHub source with a token, with the token help and a typed name', async () => {
    const created = { ...personal, id: 4, name: 'kestrel-labs', repoCount: 0 }
    const api = mockApi({
      ...routes(),
      'POST /sources/test': { ok: true, message: 'Connected as kestrel-labs-bot' },
      'POST /sources': reply(201, created),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    await user.click(await sources.findByRole('button', { name: 'Add source' }))
    const panel = within(sources.getByRole('group', { name: 'Add a source' }))
    expect(panel.getByRole('radio', { name: 'GitHub' })).toBeChecked()
    // The same help as setup, with the prefilled fine grained token.
    expect(panel.getByRole('link', { name: /Create a fine grained token/ })).toBeVisible()
    await user.type(panel.getByLabelText('Name'), 'kestrel-labs')
    await user.type(
      panel.getByLabelText('Personal access token', { selector: 'input[type=password]' }),
      'kestrel-labs-token',
    )
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    expect(
      await sources.findByText('kestrel-labs added. Connected as kestrel-labs-bot.'),
    ).toBeInTheDocument()
    expect(api.called('POST', '/sources')[0]?.body).toEqual({
      kind: 'github',
      name: 'kestrel-labs',
      baseUrl: null,
      token: 'kestrel-labs-token',
    })
    expect(sources.queryByRole('group', { name: 'Add a source' })).not.toBeInTheDocument()
  })

  it('numbers the default name of a GitHub source when one already has it', async () => {
    const api = mockApi({
      ...routes([coolifySource, githubSource]),
      'POST /sources/test': { ok: true, message: 'Connected' },
      'POST /sources': reply(201, { ...githubSource, id: 4, name: 'GitHub 2' }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    await user.click(await sources.findByRole('button', { name: 'Add source' }))
    const panel = within(sources.getByRole('group', { name: 'Add a source' }))
    await user.type(
      panel.getByLabelText('Personal access token', { selector: 'input[type=password]' }),
      'second-token',
    )
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() =>
      expect(api.called('POST', '/sources')[0]?.body).toMatchObject({ name: 'GitHub 2' }),
    )
  })

  it('adds a Coolify instance with the Coolify form', async () => {
    const api = mockApi({
      ...routes(),
      'POST /sources/test': { ok: true, message: 'Connected to Coolify 4.0.0' },
      'POST /sources': reply(201, {
        ...coolifySource,
        id: 5,
        name: 'coolify-2.example.dev',
        baseUrl: 'https://coolify-2.example.dev',
      }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    await user.click(await sources.findByRole('button', { name: 'Add source' }))
    const panel = within(sources.getByRole('group', { name: 'Add a source' }))
    await user.click(panel.getByRole('radio', { name: 'Coolify' }))
    expect(panel.queryByRole('link', { name: /fine grained token/ })).not.toBeInTheDocument()
    await user.type(panel.getByLabelText('Instance URL'), 'https://coolify-2.example.dev')
    await user.type(panel.getByLabelText('API token'), 'coolify-two-token')
    await user.click(panel.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() =>
      expect(api.called('POST', '/sources')[0]?.body).toEqual({
        kind: 'coolify',
        name: 'coolify-2.example.dev',
        baseUrl: 'https://coolify-2.example.dev',
        token: 'coolify-two-token',
      }),
    )
  })

  it('offers a GitHub App as the second way to add a GitHub source', async () => {
    mockApi(routes())
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    await user.click(await sources.findByRole('button', { name: 'Add source' }))
    const panel = within(sources.getByRole('group', { name: 'Add a source' }))
    await user.click(panel.getByRole('radio', { name: 'GitHub App' }))
    expect(panel.getByLabelText('App ID')).toBeVisible()
    // The token help is for tokens only.
    expect(panel.queryByRole('link', { name: /fine grained token/ })).not.toBeInTheDocument()
    await user.click(panel.getByRole('button', { name: 'Cancel' }))
    expect(sources.queryByRole('group', { name: 'Add a source' })).not.toBeInTheDocument()
  })

  it('says where the repos of a removed GitHub source go', async () => {
    const api = mockApi({ ...routes(), 'DELETE /sources/2': reply(204) })
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    const row = within((await sources.findByRole('heading', { name: 'kestrel-co' })).closest('li')!)
    await user.click(row.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove kestrel-co?' })
    expect(dialog).toHaveTextContent(
      'Hinomi forgets its private key. Its 12 repos move to another GitHub source that sees them, or stop being read; their findings and fix runs stay.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }))
    await waitFor(() => expect(api.called('DELETE', '/sources/2')).toHaveLength(1))
  })

  it('says the deployments of a removed Coolify source go with it', async () => {
    mockApi(routes())
    const user = userEvent.setup()
    await renderApp('/settings?sel=sources')
    const sources = await sourcesRegion()
    const row = within(
      (await sources.findByRole('heading', { name: 'coolify.example.dev' })).closest('li')!,
    )
    await user.click(row.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove coolify.example.dev?' })
    expect(dialog).toHaveTextContent('its 4 deployments are removed')
  })
})
