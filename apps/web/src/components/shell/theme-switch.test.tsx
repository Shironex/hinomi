import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cycleTheme, setTheme, syncThemeFromStorage, THEME_STORAGE_KEY } from '@/lib/theme'
import { ThemeCycleButton, ThemeSwitch } from './theme-switch'

describe('ThemeSwitch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setTheme('system')
  })

  it('applies and saves the chosen theme', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitch />)
    const group = screen.getByRole('group', { name: 'Theme' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('follows the OS preference on system', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) => ({ matches: true, media: query }) as MediaQueryList,
    )
    const user = userEvent.setup()
    render(<ThemeSwitch />)
    await user.click(screen.getByRole('button', { name: 'Light' }))
    await user.click(screen.getByRole('button', { name: 'System' }))
    expect(document.documentElement).toHaveClass('dark')
  })

  it('still switches when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const user = userEvent.setup()
    render(<ThemeSwitch />)
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement).toHaveClass('dark')
    // A blocked read falls back to system instead of throwing.
    expect(() => syncThemeFromStorage()).not.toThrow()
  })

  it('cycles system, light, dark from the icon rail button', async () => {
    const user = userEvent.setup()
    render(<ThemeCycleButton />)
    await user.click(screen.getByRole('button', { name: /Theme: System/ }))
    expect(screen.getByRole('button', { name: /Theme: Light/ })).toBeInTheDocument()
    expect(cycleTheme()).toBe('dark')
    expect(cycleTheme()).toBe('system')
  })
})
