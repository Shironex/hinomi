import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setUpdateWaitingForTest } from '@/lib/pwa'
import { UpdatePrompt } from './update-prompt'

describe('UpdatePrompt', () => {
  afterEach(() => act(() => setUpdateWaitingForTest(null)))

  it('stays hidden until a new version waits, and only swaps on click', async () => {
    const user = userEvent.setup()
    const postMessage = vi.fn()
    const addEventListener = vi.fn()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { addEventListener },
    })
    render(<UpdatePrompt />)
    expect(screen.queryByText('New version available')).not.toBeInTheDocument()

    act(() => setUpdateWaitingForTest({ postMessage } as unknown as ServiceWorker))
    expect(screen.getByText('New version available')).toBeInTheDocument()
    expect(postMessage).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /reload/i }))
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('can be dismissed', async () => {
    const user = userEvent.setup()
    render(<UpdatePrompt />)
    act(() => setUpdateWaitingForTest({ postMessage: vi.fn() } as unknown as ServiceWorker))
    await user.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('New version available')).not.toBeInTheDocument()
  })
})
