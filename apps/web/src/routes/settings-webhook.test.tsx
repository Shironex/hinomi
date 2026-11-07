import { nowMs } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXED_NOW } from '@/fixtures/dataset'
import { webhookFor as fixtureFor, WEBHOOK_SECRET } from '@/fixtures/webhook'
import { configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

async function webhookRegion() {
  return within(await screen.findByRole('region', { name: 'GitHub webhook' }))
}

/** The fixture states with their times moved to now, since tests run on the real clock. */
function webhookFor(scenario: string) {
  const shift = nowMs() - FIXED_NOW
  const move = (iso: string | null) =>
    iso ? new Date(Date.parse(iso) + shift).toISOString() : null
  const base = fixtureFor(scenario)
  return {
    ...base,
    secretCreatedAt: move(base.secretCreatedAt),
    lastDeliveryAt: move(base.lastDeliveryAt),
    lastErrorAt: move(base.lastErrorAt),
  }
}

const routesFor = (scenario: string, extra: Record<string, unknown> = {}) => ({
  ...configuredRoutes(),
  'GET /settings/github-webhook': webhookFor(scenario),
  ...extra,
})

describe('settings: GitHub webhook', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the section with a summary', async () => {
    mockApi(routesFor('webhook-on'))
    await renderApp('/settings')
    const list = within(await screen.findByRole('list', { name: 'Settings sections' }))
    expect(await list.findByText('On, last delivery 6 minutes ago')).toBeInTheDocument()
  })

  it('shows a new setup: no secret, enabling disabled with the reason', async () => {
    mockApi(routesFor('webhook-new'))
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    expect(await region.findByRole('button', { name: 'Generate secret' })).toBeEnabled()
    const enable = region.getByRole('switch', { name: 'Receive GitHub webhook deliveries' })
    expect(enable).toBeDisabled()
    expect(region.getByText(/Generate a secret first/)).toBeInTheDocument()
    expect(region.getByText('No secret yet')).toBeInTheDocument()
    expect(region.getByText('Off')).toBeInTheDocument()
  })

  it('generates a first secret without asking, and shows it once', async () => {
    let settings = webhookFor('webhook-new')
    const api = mockApi(
      routesFor('webhook-new', {
        'GET /settings/github-webhook': () => settings,
        'POST /settings/github-webhook/secret': () => {
          settings = webhookFor('webhook-off')
          return { secret: WEBHOOK_SECRET, settings }
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    await user.click(await region.findByRole('button', { name: 'Generate secret' }))
    expect(await region.findByTestId('webhook-secret')).toHaveTextContent(WEBHOOK_SECRET)
    expect(region.getByText('Shown once. Copy it now.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.called('POST', '/settings/github-webhook/secret')).toHaveLength(1)
    // The secret exists now, so the switch is usable and the button offers a rotation.
    expect(region.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument()
    expect(region.getByRole('switch', { name: 'Receive GitHub webhook deliveries' })).toBeEnabled()
    await user.click(region.getByRole('button', { name: 'I copied it' }))
    expect(region.queryByTestId('webhook-secret')).not.toBeInTheDocument()
  })

  it('asks before rotating, and Cancel sends nothing', async () => {
    const api = mockApi(
      routesFor('webhook-off', {
        'POST /settings/github-webhook/secret': {
          secret: WEBHOOK_SECRET,
          settings: webhookFor('webhook-off'),
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    await user.click(await region.findByRole('button', { name: 'Rotate secret' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the webhook secret?' })
    expect(within(dialog).getByText(/The old secret stops working/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.called('POST', '/settings/github-webhook/secret')).toHaveLength(0)

    await user.click(region.getByRole('button', { name: 'Rotate secret' }))
    const again = await screen.findByRole('dialog', { name: 'Rotate the webhook secret?' })
    await user.click(within(again).getByRole('button', { name: 'Rotate secret' }))
    expect(await region.findByTestId('webhook-secret')).toHaveTextContent(WEBHOOK_SECRET)
    expect(api.called('POST', '/settings/github-webhook/secret')).toHaveLength(1)
  })

  it('switches the webhook on and sends only that switch', async () => {
    const api = mockApi(
      routesFor('webhook-off', {
        'PATCH /settings/github-webhook': { ...webhookFor('webhook-on') },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    const enable = await region.findByRole('switch', { name: 'Receive GitHub webhook deliveries' })
    expect(enable).toBeEnabled()
    await user.click(enable)
    await waitFor(() => expect(enable).toBeChecked())
    expect(api.called('PATCH', '/settings/github-webhook')[0]?.body).toEqual({ enabled: true })
  })

  it('switches pushes on and says what it adds', async () => {
    const api = mockApi(
      routesFor('webhook-on', {
        'PATCH /settings/github-webhook': { ...webhookFor('webhook-on'), includePush: true },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    await user.click(await region.findByRole('switch', { name: 'Include push events' }))
    await waitFor(() =>
      expect(api.called('PATCH', '/settings/github-webhook')[0]?.body).toEqual({
        includePush: true,
      }),
    )
  })

  it('shows a conflict from the server under the switches', async () => {
    mockApi(
      routesFor('webhook-off', {
        'PATCH /settings/github-webhook': reply(409, {
          error: { code: 'conflict', message: 'Generate a secret first' },
        }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    await user.click(
      await region.findByRole('switch', { name: 'Receive GitHub webhook deliveries' }),
    )
    expect(await region.findByRole('alert')).toHaveTextContent('Generate a secret first.')
  })

  it('shows the last delivery, the last error, the port and the events to tick', async () => {
    mockApi(routesFor('webhook-error'))
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    expect(
      await region.findByText(/Last error 24 minutes ago: A delivery was refused/),
    ).toBeVisible()
    expect(region.getByText('On')).toBeInTheDocument()
    expect(region.getByText('3001')).toBeInTheDocument()
    const events = within(region.getByRole('list', { name: 'Events to tick in GitHub' }))
    expect(events.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Workflow runs',
      'Pull requests',
      'Check suites',
      'Check runs',
      'Statuses',
      'Pushes',
    ])
    expect(region.getByRole('button', { name: 'Copy /api/github/webhook' })).toBeInTheDocument()
    expect(region.getByRole('link', { name: /Webhook guide on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/Shironex/hinomi/blob/main/docs/github-webhook.md',
    )
  })

  it('disables everything and points at HINOMI_SECRET_KEY when no secret can be stored', async () => {
    mockApi(routesFor('webhook-nokey'))
    await renderApp('/settings?sel=webhook')
    const region = await webhookRegion()
    expect(await region.findByText('Secret key missing')).toBeVisible()
    expect(region.getByRole('button', { name: 'Generate secret' })).toBeDisabled()
    expect(region.getByRole('switch', { name: 'Receive GitHub webhook deliveries' })).toBeDisabled()
    expect(region.getByRole('switch', { name: 'Include push events' })).toBeDisabled()
    expect(region.getAllByText(/HINOMI_SECRET_KEY/).length).toBeGreaterThan(0)
  })
})
