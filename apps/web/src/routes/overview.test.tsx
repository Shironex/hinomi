import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiError,
  blindSpotItem,
  findingDetail,
  findingItem,
  findingsResponse,
  fixesResponse,
  fixItem,
  mockViews,
  overview,
} from '@/test/fixtures'
import { renderApp } from '@/test/render-app'
import { wideScreen } from '@/test/screen'

beforeEach(() => wideScreen())
afterEach(() => vi.unstubAllGlobals())

const authline = findingItem({
  id: 2,
  advisory: {
    ...findingItem().advisory!,
    packageName: 'authline',
    summary: 'Session token signature skipped',
    cvssScore: 9.1,
  },
})
const snoozed = findingItem({
  id: 1,
  state: 'snoozed',
  stateReason: 'Waiting for 14.2.9',
  stateUntil: '2026-12-04T10:00:00.000Z',
})

/** The tab lists by state: open rows need action, the rest are in progress. */
function listByState(_body: unknown, url: URL) {
  const state = url.searchParams.get('state')
  if (state === 'open') return findingsResponse([blindSpotItem(), authline])
  if (state === 'fixing,snoozed,accepted') return findingsResponse([snoozed])
  return findingsResponse([blindSpotItem()])
}

function routes(over: Record<string, unknown> = {}) {
  return {
    'GET /overview': overview(),
    'GET /findings': listByState,
    'GET /fixes': fixesResponse([fixItem()]),
    'GET /findings/9': {
      ...findingDetail(),
      ...blindSpotItem(),
      advisory: null,
      versions: { installed: null, firstPatched: null, vulnerableRanges: [] },
      dependency: { scope: 'unknown', manifestPaths: [], path: null, pathSource: 'package' },
      history: [],
    },
    'GET /findings/2': findingDetail({
      ...authline,
      advisory: { ...findingDetail().advisory!, ...authline.advisory! },
      sameFixClears: 4,
    }),
    'GET /findings/1': findingDetail({ ...snoozed, advisory: findingDetail().advisory }),
    ...over,
  }
}

describe('exposure', () => {
  it('lists what needs action with the funnel line and opens the first row beside it', async () => {
    const api = mockViews(routes())
    await renderApp('/')
    const list = await screen.findByRole('list', { name: 'Findings that need action' })
    const search = api.called('GET', '/findings').find((c) => c.search.get('state') === 'open')
    expect(search?.search.get('tier')).toBe('exposed,blind_spot')

    expect(screen.getByRole('heading', { level: 1, name: 'Exposure' })).toBeInTheDocument()
    // The funnel is one count line, every step behind it.
    const funnel = screen.getByText('4,917 alerts narrow to 2')
    expect(funnel).toHaveAttribute('title', expect.stringContaining('1,186 in a deployed repo'))

    const tabs = screen.getByRole('navigation', { name: 'Exposure views' })
    expect(within(tabs).getByRole('link', { name: 'Needs action 2' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Blind 1' })).toBeInTheDocument()
    expect(await within(tabs).findByRole('link', { name: 'In progress 1' })).toBeInTheDocument()
    expect(await within(tabs).findByRole('link', { name: 'By fix 1' })).toBeInTheDocument()

    const rows = within(list).getAllByRole('link')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('kestrel-co/docs')
    expect(rows[0]).toHaveTextContent('No GitHub alerts')
    expect(rows[1]).toHaveTextContent('authline')
    expect(rows[1]).toHaveTextContent('9.1')
    // A failing source is flagged above the list.
    expect(screen.getByText(/Bad credentials/)).toBeInTheDocument()

    // The first row is selected and its detail sits beside the list.
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Dependabot alerts are switched off for a deployed repo',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Why it ranks like a critical' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Turn on Dependabot alerts/ })).toHaveAttribute(
      'href',
      'https://github.com/kestrel-co/docs/settings/security_analysis',
    )
  })

  it('shows the fix and how many findings the same bump clears', async () => {
    mockViews(routes())
    const user = userEvent.setup()
    const { router } = await renderApp('/')
    const list = await screen.findByRole('list', { name: 'Findings that need action' })
    await user.click(within(list).getAllByRole('link')[1]!)
    expect(router.state.location.search).toMatchObject({ sel: 2 })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Session token signature skipped' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why it ranks #2' })).toBeInTheDocument()
    expect(screen.getByText('All four exposure factors are on')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The fix' })).toBeInTheDocument()
    expect(screen.getByText(/The same bump clears 4 open findings/)).toBeInTheDocument()
    expect(screen.getByText('Patch release')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open PR manually/ })).toHaveAttribute(
      'href',
      'https://github.com/kestrel-co/storefront/compare',
    )
  })

  it('opens the snooze form of the selected finding with s', async () => {
    const api = mockViews({
      ...routes(),
      'POST /findings/9/snooze': findingDetail({
        ...blindSpotItem(),
        advisory: null,
        state: 'snoozed',
        stateReason: 'Enabling next sprint',
      }),
    })
    const user = userEvent.setup()
    await renderApp('/')
    await screen.findByRole('heading', { name: 'Why it ranks like a critical' })
    await user.keyboard('s')
    const reason = await screen.findByLabelText('Reason')
    await waitFor(() => expect(reason).toHaveFocus())
    // Blind spots have no package, so they cannot wait for a new advisory.
    expect(screen.queryByRole('option', { name: 'Until a new advisory' })).not.toBeInTheDocument()
    await user.type(reason, 'Enabling next sprint')
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() =>
      expect(api.called('POST', '/findings/9/snooze')[0]?.body).toMatchObject({
        reason: 'Enabling next sprint',
      }),
    )
  })

  it('keeps snoozed findings in progress with their reason', async () => {
    mockViews(routes())
    await renderApp('/?tab=progress')
    const list = await screen.findByRole('list', { name: 'Findings in progress' })
    expect(within(list).getByText('Snoozed or accepted')).toBeInTheDocument()
    expect(within(list).getByRole('link')).toHaveTextContent('Snoozed until 4 Dec 2026')
    expect(await screen.findByText('Waiting for 14.2.9')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove decision' })).toBeInTheDocument()
  })

  it('groups the findings by the bump that clears them', async () => {
    mockViews({
      ...routes(),
      'GET /findings': (_body: unknown, url: URL) =>
        url.searchParams.get('q') === 'tessera'
          ? findingsResponse([findingItem()])
          : listByState(_body, url),
    })
    await renderApp('/?tab=fixes')
    const list = await screen.findByRole('list', { name: 'Fixes that clear the most' })
    const row = within(list).getByRole('link')
    expect(row).toHaveTextContent('tessera → 14.2.9')
    expect(row).toHaveTextContent(/3 findings cleared/)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Upgrade tessera to 14.2.9' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/One upgrade clears 3 open findings in 2 repos and 1 app/),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'kestrel-co/ledger' })).toHaveAttribute(
      'href',
      expect.stringContaining('/alerts?'),
    )
    expect(await screen.findByRole('heading', { name: 'What it clears' })).toBeInTheDocument()
  })

  it('says nothing needs action and shows what ranks below, sources and activity', async () => {
    mockViews({
      ...routes(),
      'GET /overview': overview({
        funnel: { ...overview().funnel, exposed: 0, needsAction: 0 },
        blindSpots: { total: 0, deployed: 0, public: 0, needsAction: 0 },
      }),
      'GET /findings': findingsResponse([]),
    })
    await renderApp('/')
    expect(await screen.findByText('Nothing exposed on a public app')).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Nothing needs action on a public app' }),
    ).toBeInTheDocument()
    expect(screen.getByText('OSV.dev lockfile scan')).toBeInTheDocument()
    expect(screen.getByText('Snooze expired, back in the ranking')).toBeInTheDocument()
    expect(screen.getByText(/3,731 alerts in repos that are not/)).toBeInTheDocument()
    const internal = screen.getByRole('link', { name: /Deployed, internal only/ })
    expect(internal).toHaveTextContent('12 critical, 30 high, 60 moderate, 16 low')
  })

  it('opens a row as its own page on a phone, with previous and next', async () => {
    vi.unstubAllGlobals()
    mockViews(routes())
    const user = userEvent.setup()
    await renderApp('/')
    const list = await screen.findByRole('list', { name: 'Findings that need action' })
    expect(screen.queryByRole('heading', { name: /Why it ranks/ })).not.toBeInTheDocument()
    await user.click(within(list).getAllByRole('link')[0]!)
    expect(await screen.findByText('#1 of 2')).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Why it ranks like a critical' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('#2 of 2')).toBeInTheDocument()
    // The phone fix card: the bump, what it clears, one wide button.
    expect(await screen.findByText('Clears 4 findings')).toBeInTheDocument()
  })

  it('points a fresh install at onboarding', async () => {
    mockViews(routes({ 'GET /overview': overview({ sources: [], lastScan: null }) }))
    await renderApp('/')
    expect(await screen.findByText('No scan yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect sources' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
  })

  it('shows an error with a retry', async () => {
    const api = mockViews(
      routes({ 'GET /overview': () => apiError(500, 'internal', 'Database locked') }),
    )
    await renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Exposure did not load')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.called('GET', '/overview').length).toBeGreaterThan(1)
  })
})
