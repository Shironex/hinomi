import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blindSpotItem,
  findingItem,
  findingsResponse,
  overview,
  apiError,
  mockViews,
} from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

describe('overview', () => {
  it('shows the counts, the funnel and the ranked list with decided rows kept', async () => {
    const api = mockViews({
      'GET /overview': overview(),
      'GET /findings': findingsResponse([
        findingItem({
          id: 1,
          state: 'snoozed',
          stateReason: 'Waiting for 14.2.9',
          stateUntil: '2026-12-04T10:00:00.000Z',
        }),
        blindSpotItem(),
        findingItem({
          id: 2,
          advisory: {
            ...findingItem().advisory!,
            packageName: 'authline',
            summary: 'Session token signature skipped',
          },
        }),
      ]),
    })
    await renderApp('/')
    expect(
      await screen.findByRole('heading', { level: 1, name: '2 exposed, 1 needs action' }),
    ).toBeInTheDocument()
    expect(api.called('GET', '/findings')[0]?.search.get('tier')).toBe('blind_spot,exposed')

    const funnel = screen.getByRole('navigation', { name: /4,917 alerts narrow down to 2 exposed/ })
    expect(within(funnel).getByText('Exposed on a public app')).toBeInTheDocument()
    // Repo and app counts per step come from the server.
    expect(within(funnel).getByText('64 repos')).toBeInTheDocument()
    expect(within(funnel).getByText('22 repos, 31 apps')).toBeInTheDocument()
    expect(within(funnel).getByText('2 repos, 2 apps')).toBeInTheDocument()

    const rows = within(
      screen.getByRole('region', { name: 'Exposed findings and blind spots' }),
    ).getAllByRole('link', {
      name: /Remote code|Session token|Dependabot alerts/,
    })
    // Needs action first, the snoozed finding after them, never dropped.
    expect(rows.map((r) => r.textContent)).toEqual([
      'Dependabot alerts are switched off for a deployed repo',
      'Session token signature skipped',
      'Remote code execution through crafted server action payloads',
    ])
    expect(screen.getByText('Snoozed until 4 Dec 2026')).toBeInTheDocument()
    expect(screen.getByText('Waiting for 14.2.9')).toBeInTheDocument()
    expect(screen.getByText('No GitHub alerts')).toBeInTheDocument()

    expect(screen.getByText('Bad credentials')).toBeInTheDocument()
    expect(screen.getByText('Snooze expired, back in the ranking')).toBeInTheDocument()
    expect(screen.getByText(/3,731 alerts in repos that are not/)).toBeInTheDocument()
    // Each tier card below the line shows its severity mix.
    const internal = screen.getByRole('link', { name: /Deployed, internal only/ })
    expect(internal).toHaveTextContent('12 critical, 30 high, 60 moderate, 16 low')
  })

  it('says nothing is exposed when the list is empty', async () => {
    mockViews({
      'GET /overview': overview({
        funnel: { ...overview().funnel, exposed: 0, needsAction: 0 },
        blindSpots: { total: 0, deployed: 0, public: 0, needsAction: 0 },
      }),
      'GET /findings': findingsResponse([]),
    })
    await renderApp('/')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Nothing is exposed right now' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Nothing exposed on a public app')).toBeInTheDocument()
  })

  it('points a fresh install at onboarding', async () => {
    mockViews({
      'GET /overview': overview({ sources: [], lastScan: null }),
      'GET /findings': findingsResponse([]),
    })
    await renderApp('/')
    expect(await screen.findByText('No scan yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect sources' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
  })

  it('shows an error with a retry', async () => {
    const api = mockViews({
      'GET /overview': () => apiError(500, 'internal', 'Database locked'),
      'GET /findings': findingsResponse([]),
    })
    await renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Exposure did not load')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.called('GET', '/overview').length).toBeGreaterThan(1)
  })
})
