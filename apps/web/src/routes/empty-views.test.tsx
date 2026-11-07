import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredRoutes, mockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'

describe('empty split views', () => {
  afterEach(() => vi.unstubAllGlobals())

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
