import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channel,
  configuredRoutes,
  coolifySource,
  deployment,
  mockApi,
  reply,
} from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

async function sourcesRegion() {
  return within(await screen.findByRole('region', { name: 'Sources' }))
}

describe('settings', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the no login note and never shows a token', async () => {
    mockApi(configuredRoutes())
    await renderApp('/settings')
    expect(await screen.findByText('Hinomi has no login yet')).toBeVisible()
    const sources = await sourcesRegion()
    expect(await sources.findByRole('heading', { name: 'coolify.example.dev' })).toBeInTheDocument()
    expect(sources.getAllByText('Set')).toHaveLength(2)
  })

  it('tests a saved source and shows the answer', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'POST /sources/1/test': { ok: true, message: 'Connected to Coolify 4.0.0' },
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const sources = await sourcesRegion()
    await user.click((await sources.findAllByRole('button', { name: 'Test connection' }))[0]!)
    expect(await sources.findByText('Connected to Coolify 4.0.0.')).toBeInTheDocument()
    expect(api.called('POST', '/sources/1/test')).toHaveLength(1)
  })

  it('replaces a token after testing it', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'POST /sources/test': { ok: true, message: 'Connected to Coolify 4.0.0' },
      'PATCH /sources/1': coolifySource,
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const sources = await sourcesRegion()
    await user.click((await sources.findAllByRole('button', { name: 'Replace token' }))[0]!)
    await user.type(sources.getByLabelText('New api token'), 'kestrel-new-token')
    await user.click(sources.getByRole('button', { name: 'Test and save token' }))
    expect(
      await sources.findByText('Token replaced. Connected to Coolify 4.0.0.'),
    ).toBeInTheDocument()
    expect(api.called('PATCH', '/sources/1')[0]?.body).toEqual({ token: 'kestrel-new-token' })
  })

  it('asks before removing a source', async () => {
    const api = mockApi({ ...configuredRoutes(), 'DELETE /sources/1': reply(204) })
    const user = userEvent.setup()
    await renderApp('/settings')
    const sources = await sourcesRegion()
    await user.click((await sources.findAllByRole('button', { name: 'Remove' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Remove coolify.example.dev?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }))
    await waitFor(() => expect(api.called('DELETE', '/sources/1')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('adds a webhook channel with inline validation', async () => {
    let channels: unknown[] = []
    const api = mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': () => ({ items: channels }),
      'POST /notifications/channels': () => {
        channels = [channel]
        return reply(201, channel)
      },
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = within(await screen.findByRole('region', { name: 'Notifications' }))
    await user.click(await region.findByRole('button', { name: 'Add channel' }))
    await user.click(region.getByRole('radio', { name: 'Webhook' }))
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    const url = region.getByLabelText('Webhook webhook URL')
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(url).toHaveAccessibleDescription(/Paste the webhook URL\./)
    expect(api.called('POST', '/notifications/channels')).toHaveLength(0)

    await user.type(region.getByLabelText('Name'), 'Incident bot')
    await user.type(url, 'https://hooks.example.dev/hinomi')
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    expect(await region.findByRole('heading', { name: 'Incident bot' })).toBeInTheDocument()
    expect(api.called('POST', '/notifications/channels')[0]?.body).toEqual({
      kind: 'webhook',
      name: 'Incident bot',
      url: 'https://hooks.example.dev/hinomi',
      minSeverity: 'high',
    })
  })

  it('puts a refused Discord URL by its field', async () => {
    mockApi({
      ...configuredRoutes(),
      'POST /notifications/channels': reply(400, {
        error: {
          code: 'validation_failed',
          message: 'A Discord webhook URL is https://discord.com/api/webhooks/...',
        },
      }),
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = within(await screen.findByRole('region', { name: 'Notifications' }))
    await user.click(await region.findByRole('button', { name: 'Add channel' }))
    const url = region.getByLabelText('Discord webhook URL')
    await user.type(url, 'https://hooks.example.dev/not-discord')
    await user.click(region.getByRole('button', { name: 'Add channel' }))
    await waitFor(() => expect(url).toHaveAttribute('aria-invalid', 'true'))
    expect(url).toHaveAccessibleDescription(/A Discord webhook URL is/)
  })

  it('sends a test message and reports a failure', async () => {
    mockApi({
      ...configuredRoutes(),
      'GET /notifications/channels': { items: [channel] },
      [`POST /notifications/channels/${channel.id}/test`]: {
        ok: false,
        error: 'The webhook answered HTTP 404',
      },
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = within(await screen.findByRole('region', { name: 'Notifications' }))
    expect(await region.findByText(channel.url)).toBeInTheDocument()
    await user.click(region.getByRole('button', { name: 'Send test' }))
    expect(
      await region.findByText('Test failed: The webhook answered HTTP 404.'),
    ).toBeInTheDocument()
  })

  it('saves the scan interval when it changes', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'PATCH /settings': { scanIntervalMinutes: 60, osvEnabled: true, includeAccountRepos: false },
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    await user.selectOptions(await screen.findByLabelText('Scan every'), '60')
    await waitFor(() =>
      expect(api.called('PATCH', '/settings')[0]?.body).toEqual({ scanIntervalMinutes: 60 }),
    )
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('maps a repo to a deployment', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'GET /deployments': {
        items: [deployment({ mapping: 'none', repos: [], gitRepository: null })],
      },
      'POST /deployments/11/overrides': reply(201, { items: [] }),
    })
    const user = userEvent.setup()
    await renderApp('/settings')
    const region = within(await screen.findByRole('region', { name: 'Repo mapping' }))
    expect(await region.findByText('Needs mapping')).toBeInTheDocument()
    await user.click(region.getByRole('button', { name: 'Map a repo to storefront-web' }))
    await user.type(region.getByLabelText('Repo', { exact: true }), 'storefront')
    await user.click(region.getByRole('button', { name: 'Save mapping' }))
    expect(region.getByLabelText('Repo', { exact: true })).toHaveAccessibleDescription(
      /Must be owner\/name\./,
    )
    await user.clear(region.getByLabelText('Repo', { exact: true }))
    await user.type(region.getByLabelText('Repo', { exact: true }), 'kestrel-co/storefront')
    await user.click(region.getByRole('button', { name: 'Save mapping' }))
    await waitFor(() =>
      expect(api.called('POST', '/deployments/11/overrides')[0]?.body).toEqual({
        repo: 'kestrel-co/storefront',
        note: null,
      }),
    )
  })
})
