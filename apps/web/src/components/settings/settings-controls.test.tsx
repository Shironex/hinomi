import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINDINGS } from '@/fixtures/dataset'
import { guardsResponseOf, overridesOf } from '@/fixtures/guards'
import { configuredRoutes, mockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const settings = (over: Record<string, unknown> = {}) => ({
  scanIntervalMinutes: 360,
  osvEnabled: true,
  includeAccountRepos: false,
  updateCheckEnabled: true,
  supportWindowDays: 90,
  imageScan: 'off',
  rustBehindReleases: 4,
  bunBehindReleases: 4,
  ...over,
})

describe('image scan setting', () => {
  it('saves the mode and explains what each one needs', async () => {
    const api = mockApi({
      ...configuredRoutes(),
      'PATCH /settings': settings({ imageScan: 'sbom' }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=scans')
    const select = await screen.findByLabelText('Scan images')
    expect(select).toHaveValue('off')
    expect(screen.getByText(/Needs Coolify/)).toHaveTextContent('4.7.0')
    expect(screen.getByText(/SBOM attestation of their registry images/)).toBeInTheDocument()
    await user.selectOptions(select, 'sbom')
    await waitFor(() =>
      expect(api.called('PATCH', '/settings')[0]?.body).toEqual({ imageScan: 'sbom' }),
    )
  })
})

describe('support thresholds', () => {
  const routes = () => ({
    ...configuredRoutes(),
    'GET /guards': guardsResponseOf(FINDINGS),
    'GET /overrides': { items: overridesOf(FINDINGS) },
  })

  it('saves only the changed numbers', async () => {
    const api = mockApi({
      ...routes(),
      'PATCH /settings': settings({ supportWindowDays: 120, bunBehindReleases: 6 }),
    })
    const user = userEvent.setup()
    await renderApp('/settings?sel=checks')
    const days = await screen.findByLabelText('Warn before end of life')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.clear(days)
    await user.type(days, '120')
    await user.clear(screen.getByLabelText('Bun releases behind'))
    await user.type(screen.getByLabelText('Bun releases behind'), '6')
    await user.click(save)
    await waitFor(() =>
      expect(api.called('PATCH', '/settings')[0]?.body).toEqual({
        supportWindowDays: 120,
        bunBehindReleases: 6,
      }),
    )
  })

  it('refuses a number outside the server range without sending it', async () => {
    const api = mockApi(routes())
    const user = userEvent.setup()
    await renderApp('/settings?sel=checks')
    const rust = await screen.findByLabelText('Rust releases behind')
    await user.clear(rust)
    await user.type(rust, '51')
    expect(
      within(rust.closest('div')!.parentElement!).getByText('Enter a whole number from 1 to 50.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.called('PATCH', '/settings')).toHaveLength(0)
  })
})
