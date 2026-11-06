import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blindSpotItem, findingDetail, apiError, mockViews } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

describe('finding detail', () => {
  it('explains why it ranks, where it runs and its history', async () => {
    mockViews({ 'GET /findings/1': findingDetail() })
    await renderApp('/finding/1')
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Remote code execution through crafted server action payloads',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why this ranks at the top' })).toBeInTheDocument()
    expect(screen.getByText('Attack vector: network')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /storefront-web/ })).toHaveAttribute(
      'href',
      '/deployments/1',
    )
    expect(screen.getByLabelText('Dependency path')).toHaveTextContent('tessera@14.2.3')
    expect(screen.getByText('First seen by a scan')).toBeInTheDocument()
  })

  it('snoozes with a reason and an expiry, opened with s', async () => {
    const api = mockViews({
      'GET /findings/1': findingDetail(),
      'POST /findings/1/accept': findingDetail({
        state: 'accepted',
        stateReason: 'Edge rate limit covers it',
        stateUntil: '2026-12-31T10:00:00.000Z',
      }),
    })
    const user = userEvent.setup()
    await renderApp('/finding/1')
    await screen.findByRole('heading', { level: 1 })
    await user.keyboard('s')
    const reason = await screen.findByLabelText('Reason')
    await waitFor(() => expect(reason).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    expect(screen.getByText('Add a reason so the next person knows why.')).toBeInTheDocument()
    expect(api.called('POST', '/findings/1/accept')).toHaveLength(0)

    await user.click(screen.getByRole('radio', { name: 'Accept risk' }))
    await user.type(reason, 'Edge rate limit covers it')
    await user.selectOptions(screen.getByLabelText('Expires'), '7')
    await user.click(screen.getByRole('button', { name: 'Save decision' }))

    expect(
      await screen.findByText(/Risk accepted until 31 Dec 2026/, { selector: 'b' }),
    ).toBeInTheDocument()
    const body = api.called('POST', '/findings/1/accept')[0]?.body as {
      reason: string
      until: string
    }
    expect(body.reason).toBe('Edge rate limit covers it')
    const days = (Date.parse(body.until) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('shows a server refusal inside the form', async () => {
    mockViews({
      'GET /findings/1': findingDetail(),
      'POST /findings/1/snooze': () =>
        apiError(400, 'validation_failed', 'The expiry must be in the future'),
    })
    const user = userEvent.setup()
    await renderApp('/finding/1')
    // The actions sit in the side column on desktop and above the content on a phone.
    await user.click((await screen.findAllByRole('button', { name: /Snooze or accept risk/ }))[0]!)
    await user.type(screen.getByLabelText('Reason'), 'Later')
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The expiry must be in the future')
  })

  it('removes a decision with reopen', async () => {
    const api = mockViews({
      'GET /findings/1': findingDetail({
        state: 'snoozed',
        stateReason: 'Waiting for upstream',
        stateUntil: '2026-12-04T10:00:00.000Z',
      }),
      'POST /findings/1/reopen': findingDetail(),
    })
    const user = userEvent.setup()
    await renderApp('/finding/1')
    expect(await screen.findByText('Waiting for upstream')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove decision' }))
    await waitFor(() => expect(api.called('POST', '/findings/1/reopen')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByText('Waiting for upstream')).not.toBeInTheDocument())
  })

  it('tells how to close a blind spot', async () => {
    mockViews({
      'GET /findings/9': {
        ...findingDetail(),
        ...blindSpotItem(),
        advisory: null,
        versions: { installed: null, firstPatched: null, vulnerableRanges: [] },
        dependency: { scope: 'unknown', manifestPaths: [] },
        history: [],
      },
    })
    await renderApp('/finding/9')
    expect(
      await screen.findByRole('heading', { name: 'Why this ranks like a critical' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Enable Dependabot alerts')).toBeInTheDocument()
  })

  it('says when the finding does not exist', async () => {
    mockViews({ 'GET /findings/77': () => apiError(404, 'not_found', 'Finding not found') })
    await renderApp('/finding/77')
    expect(await screen.findByText('Nothing recorded for this finding')).toBeInTheDocument()
  })
})
