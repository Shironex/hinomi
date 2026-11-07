import { nowMs } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXED_NOW } from '@/fixtures/dataset'
import { RUNNER_SECRET, webhookRunnerFor as fixtureFor } from '@/fixtures/webhook-runner'
import { configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

const region = async () => within(await screen.findByRole('region', { name: 'Webhook runner' }))

/** The fixture states with their times moved to now, since tests run on the real clock. */
function runnerFor(scenario: string) {
  const shift = nowMs() - FIXED_NOW
  const move = (iso: string | null) =>
    iso ? new Date(Date.parse(iso) + shift).toISOString() : null
  const base = fixtureFor(scenario)
  return {
    ...base,
    secretCreatedAt: move(base.secretCreatedAt),
    lastCallbackAt: move(base.lastCallbackAt),
    lastErrorAt: move(base.lastErrorAt),
  }
}

const routesFor = (scenario: string, extra: Record<string, unknown> = {}) => ({
  ...configuredRoutes(),
  'GET /settings/webhook-runner': runnerFor(scenario),
  ...extra,
})

describe('settings: webhook runner', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is listed with a summary', async () => {
    mockApi(routesFor('runner-on'))
    await renderApp('/settings')
    const list = within(await screen.findByRole('list', { name: 'Settings sections' }))
    expect(await list.findByText('Webhook runner')).toBeInTheDocument()
    expect(await list.findByText('Configured')).toBeInTheDocument()
  })

  it('shows a new setup: nothing configured, no secret, the way forward', async () => {
    mockApi(routesFor('runner-new'))
    await renderApp('/settings?sel=runner')
    const view = await region()
    expect(
      await view.findByText('Not configured', { selector: '[data-slot="badge"]' }),
    ).toBeVisible()
    expect(
      view.getByText('Set the webhook runner URL and generate its secret first.'),
    ).toBeVisible()
    expect(view.getByText('No callback has arrived yet')).toBeVisible()
    expect(view.getByText('No secret yet')).toBeVisible()
    expect(view.getByRole('button', { name: 'Generate secret' })).toBeEnabled()
    expect(view.getByLabelText('Runner URL')).toHaveValue('')
  })

  it('saves the URL and sends only what changed', async () => {
    let settings = runnerFor('runner-new')
    const api = mockApi(
      routesFor('runner-new', {
        'GET /settings/webhook-runner': () => settings,
        'PATCH /settings/webhook-runner': (body: unknown) => {
          settings = { ...settings, ...(body as object), message: 'Generate its secret first.' }
          return settings
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    const save = await view.findByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.type(await view.findByLabelText('Runner URL'), 'https://runner.example.dev/hinomi')
    await user.click(save)
    await waitFor(() =>
      expect(api.called('PATCH', '/settings/webhook-runner')[0]?.body).toEqual({
        url: 'https://runner.example.dev/hinomi',
      }),
    )
    expect(await view.findByText('Generate its secret first.')).toBeVisible()
  })

  it('clears a URL when the field is emptied', async () => {
    const api = mockApi(
      routesFor('runner-on', {
        'PATCH /settings/webhook-runner': runnerFor('runner-new'),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    await user.clear(await view.findByLabelText('Runner URL'))
    await user.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.called('PATCH', '/settings/webhook-runner')[0]?.body).toEqual({ url: null }),
    )
  })

  it('shows the 422 of a URL the server refuses next to the field', async () => {
    mockApi(
      routesFor('runner-new', {
        'PATCH /settings/webhook-runner': reply(422, {
          error: {
            code: 'validation_failed',
            message: 'The runner URL must use https, or allow private addresses first.',
          },
        }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    const input = await view.findByLabelText('Runner URL')
    await user.type(input, 'http://10.0.0.5/hook')
    await user.click(view.getByRole('button', { name: 'Save' }))
    const error = await view.findByText(
      'The runner URL must use https, or allow private addresses first.',
    )
    expect(error).toBeVisible()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(/must use https/)
    // The text is not doubled up with another period.
    expect(error.textContent).not.toContain('..')
  })

  it('switches private addresses on with a risk note, and shows a refusal', async () => {
    const api = mockApi(
      routesFor('runner-on', {
        'PATCH /settings/webhook-runner': reply(422, {
          error: { code: 'validation_failed', message: 'The stored URL is a private address' },
        }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    const toggle = await view.findByRole('switch', {
      name: 'Allow private addresses for the webhook runner',
    })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/internal services included/)
    await user.click(toggle)
    await waitFor(() =>
      expect(api.called('PATCH', '/settings/webhook-runner')[0]?.body).toEqual({
        allowPrivate: true,
      }),
    )
    expect(await view.findByRole('alert')).toHaveTextContent('The stored URL is a private address.')
  })

  it('generates a first secret without asking, and shows it once', async () => {
    let settings = runnerFor('runner-new')
    const api = mockApi(
      routesFor('runner-new', {
        'GET /settings/webhook-runner': () => settings,
        'POST /settings/webhook-runner/secret': () => {
          settings = runnerFor('runner-on')
          return reply(201, { secret: RUNNER_SECRET, settings })
        },
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    await user.click(await view.findByRole('button', { name: 'Generate secret' }))
    expect(await view.findByTestId('runner-secret')).toHaveTextContent(RUNNER_SECRET)
    expect(view.getByText('Shown once. Copy it now.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.called('POST', '/settings/webhook-runner/secret')).toHaveLength(1)
    expect(view.getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument()
    await user.click(view.getByRole('button', { name: 'I copied it' }))
    expect(view.queryByTestId('runner-secret')).not.toBeInTheDocument()
  })

  it('asks before rotating, and Cancel sends nothing', async () => {
    const api = mockApi(
      routesFor('runner-on', {
        'POST /settings/webhook-runner/secret': reply(201, {
          secret: RUNNER_SECRET,
          settings: runnerFor('runner-on'),
        }),
      }),
    )
    const user = userEvent.setup()
    await renderApp('/settings?sel=runner')
    const view = await region()
    await user.click(await view.findByRole('button', { name: 'Rotate secret' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the runner secret?' })
    expect(within(dialog).getByText(/The old secret stops working/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.called('POST', '/settings/webhook-runner/secret')).toHaveLength(0)

    await user.click(view.getByRole('button', { name: 'Rotate secret' }))
    const again = await screen.findByRole('dialog', { name: 'Rotate the runner secret?' })
    await user.click(within(again).getByRole('button', { name: 'Rotate secret' }))
    expect(await view.findByTestId('runner-secret')).toHaveTextContent(RUNNER_SECRET)
    expect(api.called('POST', '/settings/webhook-runner/secret')).toHaveLength(1)
  })

  it('shows the configured state, the last callback, the callback path and the port', async () => {
    mockApi(routesFor('runner-on'))
    await renderApp('/settings?sel=runner')
    const view = await region()
    expect(await view.findByText('Configured', { selector: '[data-slot="badge"]' })).toBeVisible()
    expect(view.getByText('Last callback 9 minutes ago')).toBeVisible()
    expect(view.getByLabelText('Runner URL')).toHaveValue('https://runner.example.dev/hinomi')
    expect(view.getByRole('button', { name: 'Copy /api/runner/callback' })).toBeInTheDocument()
    expect(view.getAllByText('3001').length).toBeGreaterThan(0)
    expect(view.getByRole('button', { name: 'Copy 3001' })).toBeInTheDocument()
    expect(view.getByRole('link', { name: /Fix runners guide on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/Shironex/hinomi/blob/main/docs/runners.md',
    )
  })

  it('shows the last error', async () => {
    mockApi(routesFor('runner-error'))
    await renderApp('/settings?sel=runner')
    const view = await region()
    expect(await view.findByText(/Last error 18 minutes ago: A callback was refused/)).toBeVisible()
    expect(
      view.getByRole('switch', { name: 'Allow private addresses for the webhook runner' }),
    ).toBeChecked()
  })

  it('points at HINOMI_SECRET_KEY when no secret can be stored', async () => {
    mockApi({
      ...routesFor('runner-new'),
      'GET /settings/webhook-runner': { ...runnerFor('runner-new'), canStoreSecret: false },
    })
    await renderApp('/settings?sel=runner')
    const view = await region()
    expect(await view.findByText('Secret key missing')).toBeVisible()
    expect(view.getByRole('button', { name: 'Generate secret' })).toBeDisabled()
  })
})
