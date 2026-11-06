import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blindSpotItem,
  findingDetail,
  findingItem,
  findingsResponse,
  apiError,
  mockViews,
} from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const internal = (id: number, pkg: string) =>
  findingItem({
    id,
    tier: 'internal',
    factors: { severity: 'high', runtime: true, deployed: true, public: false },
    advisory: { ...findingItem().advisory!, packageName: pkg },
  })

const grouped = findingsResponse(
  [blindSpotItem(), internal(4, 'yamlette'), internal(5, 'minirouter')],
  {
    group: 'tier',
    total: 4,
    nextOffset: 3,
    groups: [
      { key: 'blind_spot', label: 'Blind spots', count: 1 },
      { key: 'internal', label: 'Deployed, internal only', count: 3 },
    ],
  },
)

function listResponse(_body: unknown, url: URL) {
  if (url.searchParams.get('offset') === '3') {
    return findingsResponse([internal(6, 'csv-forge')], {
      group: 'tier',
      total: 4,
      offset: 3,
      groups: grouped.groups,
    })
  }
  return grouped
}

describe('all alerts', () => {
  it('groups rows by tier and loads more pages', async () => {
    const api = mockViews({ 'GET /findings': listResponse })
    await renderApp('/alerts')
    expect(await screen.findByText('Tier 2: Deployed, internal only')).toBeInTheDocument()
    expect(api.called('GET', '/findings')[0]?.search.get('group')).toBe('tier')
    expect(screen.getByRole('link', { name: 'yamlette' })).toHaveAttribute('href', '/finding/4')
    expect(screen.getByText('1 more in this group, load more below')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: /Show 1 more/ }))
    expect(await screen.findByRole('link', { name: 'csv-forge' })).toBeInTheDocument()
    expect(api.called('GET', '/findings').at(-1)?.search.get('offset')).toBe('3')
  })

  it('turns filters into query params and offers to clear them', async () => {
    const api = mockViews({
      'GET /findings': (_body: unknown, url: URL) =>
        url.searchParams.get('severity') ? findingsResponse([]) : grouped,
    })
    const user = userEvent.setup()
    const { router } = await renderApp('/alerts')
    await screen.findByText('Tier 2: Deployed, internal only')

    await user.click(screen.getByRole('button', { name: 'Low' }))
    await waitFor(() =>
      expect(api.called('GET', '/findings').at(-1)?.search.get('severity')).toBe(
        'critical,high,moderate',
      ),
    )
    expect(router.state.location.search).toMatchObject({
      severity: ['critical', 'high', 'moderate'],
    })
    expect(await screen.findByText('No alerts match these filters')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /Clear filters/ })[0]!)
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('severity'))
  })

  it('searches after typing stops', async () => {
    const api = mockViews({ 'GET /findings': grouped })
    const user = userEvent.setup()
    await renderApp('/alerts')
    await user.type(await screen.findByRole('searchbox', { name: 'Search alerts' }), 'yaml')
    await waitFor(() => expect(api.called('GET', '/findings').at(-1)?.search.get('q')).toBe('yaml'))
  })

  it('snoozes the selected rows with one reason and reports any that fail', async () => {
    const api = mockViews({
      'GET /findings': grouped,
      'POST /findings/4/snooze': findingDetail({ id: 4, state: 'snoozed' }),
      'POST /findings/5/snooze': () =>
        apiError(409, 'conflict', 'A fixed finding cannot be moved to snoozed'),
    })
    const user = userEvent.setup()
    await renderApp('/alerts')
    await user.click(
      await screen.findByRole('checkbox', {
        name: /Select the 2 loaded in Deployed, internal only/,
      }),
    )
    const bar = screen.getByRole('region', { name: 'Bulk actions' })
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: 'Snooze' }))
    await user.click(within(bar).getByRole('button', { name: 'Save' }))
    expect(within(bar).getByText('Add a reason so the next person knows why.')).toBeInTheDocument()

    await user.type(within(bar).getByLabelText(/Why snooze these/), 'Internal only, behind the VPN')
    await user.click(within(bar).getByRole('button', { name: 'Save' }))
    expect(await within(bar).findByRole('alert')).toHaveTextContent(
      '1 of 2 saved. Not saved: minirouter in kestrel-co/storefront',
    )
    const body = api.called('POST', '/findings/4/snooze')[0]?.body as {
      reason: string
      until: string
    }
    expect(body.reason).toBe('Internal only, behind the VPN')
    expect(Date.parse(body.until)).toBeGreaterThan(Date.now())
    // Only the failed row stays selected.
    expect(within(bar).getByText('1 selected')).toBeInTheDocument()
  })

  it('selects the keyboard row with x', async () => {
    mockViews({ 'GET /findings': grouped })
    const user = userEvent.setup()
    await renderApp('/alerts')
    await screen.findByText('Tier 2: Deployed, internal only')
    await user.keyboard('jx')
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('1 selected')
  })

  it('teaches where alerts come from when there are none', async () => {
    mockViews({ 'GET /findings': findingsResponse([], { group: 'tier' }) })
    await renderApp('/alerts')
    expect(await screen.findByText('No alerts yet')).toBeInTheDocument()
  })
})
