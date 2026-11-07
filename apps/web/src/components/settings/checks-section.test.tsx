import { GUARD_CHECKS } from '@hinomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINDINGS } from '@/fixtures/dataset'
import { guardsResponseOf, overridesOf } from '@/fixtures/guards'
import { configuredRoutes, mockApi, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const routes = () => ({
  ...configuredRoutes(),
  'GET /guards': guardsResponseOf(FINDINGS),
  'GET /overrides': { items: overridesOf(FINDINGS) },
})

describe('settings checks', () => {
  it('lists every check with what it reads, its counts and the overrides with their reasons', async () => {
    mockApi(routes())
    await renderApp('/settings?sel=checks')
    const region = within(await screen.findByRole('region', { name: 'Checks' }))
    const checks = within(await region.findByRole('list', { name: 'Checks' }))
    expect(checks.getAllByRole('listitem')).toHaveLength(GUARD_CHECKS.length)
    expect(checks.getByText('Container runs as root')).toBeInTheDocument()
    expect(checks.getByRole('link', { name: 'Container runs as root findings' })).toHaveAttribute(
      'href',
      '/guards?check=%5B%22root_user%22%5D',
    )

    const overrides = within(region.getByRole('list', { name: 'Overrides' }))
    expect(overrides.getAllByRole('listitem')).toHaveLength(2)
    for (const o of overridesOf(FINDINGS)) {
      expect(overrides.getByText(`“${o.reason}”`)).toBeInTheDocument()
    }
  })

  it('edits the reason of an override and turns the check back on', async () => {
    const [first] = overridesOf(FINDINGS)
    const api = mockApi({
      ...routes(),
      [`PATCH /overrides/${first!.id}`]: { ...first, reason: 'Reachable over the VPN only' },
      [`DELETE /overrides/${first!.id}`]: reply(204),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=checks')
    const overrides = within(await screen.findByRole('list', { name: 'Overrides' }))
    await user.click(overrides.getAllByRole('button', { name: /^Edit / })[0]!)

    const dialog = await screen.findByRole('dialog', { name: 'Turned off with a reason' })
    const reason = within(dialog).getByLabelText('Reason')
    expect(reason).toHaveValue(first!.reason)
    await user.clear(reason)
    await user.type(reason, 'Reachable over the VPN only')
    await user.click(within(dialog).getByRole('button', { name: 'Save reason' }))
    await waitFor(() =>
      expect(api.called('PATCH', `/overrides/${first!.id}`)[0]?.body).toEqual({
        reason: 'Reachable over the VPN only',
      }),
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(overrides.getAllByRole('button', { name: /^Edit / })[0]!)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Turn the check back on',
      }),
    )
    await waitFor(() => expect(api.called('DELETE', `/overrides/${first!.id}`)).toHaveLength(1))
  })

  it('says when no check is turned off', async () => {
    mockApi({ ...routes(), 'GET /overrides': { items: [] } })
    await renderApp('/settings?sel=checks')
    expect(await screen.findByText('No check is turned off.')).toBeInTheDocument()
  })
})
