import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, mockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

/** Makes the width queries match, as on a screen of 1100 px or more. */
function wideScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('empty split views', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('teaches what fix runs are and links to the findings', async () => {
    mockApi(configuredRoutes())
    await renderApp('/fix-runs')
    expect(await screen.findByRole('heading', { level: 1, name: 'Fix runs' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'No fix runs yet' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Pick a finding to fix' })).toHaveAttribute('href', '/')
  })

  it('puts the empty fix runs state in the detail pane on a wide screen', async () => {
    wideScreen()
    mockApi(configuredRoutes())
    await renderApp('/fix-runs')
    expect(await screen.findByText('Nothing here yet')).toBeVisible()
    const detail = within(screen.getByRole('region', { name: 'Fix runs' }))
    expect(detail.getByRole('heading', { level: 2, name: 'No fix runs yet' })).toBeVisible()
    // Nothing to move through, so the key bar only offers all keys.
    expect(screen.queryByText('move')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /all keys/ })).toBeInTheDocument()
  })

  it('says drift guards arrive in phase 2 and lists what they will check', async () => {
    mockApi(configuredRoutes())
    await renderApp('/drift')
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Drift guards arrive in phase 2' }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Follow the roadmap' })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/spec.md'),
    )
    expect(screen.getByRole('heading', { name: 'Container runs as root' })).toBeInTheDocument()
  })
})
