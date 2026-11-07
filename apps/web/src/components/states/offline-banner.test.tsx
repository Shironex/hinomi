import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { OfflineBanner } from './offline-banner'

function setOnline(value: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(value)
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'))
  })
}

describe('OfflineBanner', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows only while offline and recovers when back online', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<OfflineBanner />)
    expect(screen.queryByText('You are offline')).not.toBeInTheDocument()

    setOnline(false)
    expect(screen.getByRole('status')).toHaveTextContent('You are offline')

    setOnline(true)
    expect(screen.queryByText('You are offline')).not.toBeInTheDocument()
  })

  it('describes a failed request as offline instead of a server problem', () => {
    const error = new ApiError('network', '/alerts', 'Failed to fetch')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(describeError(error)).toMatch(/offline/)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    expect(describeError(error)).toMatch(/did not answer/)
  })
})
