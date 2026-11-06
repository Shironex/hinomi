import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Testing Library waits 1 s by default, tuned for an idle machine. A cold first render of a route
// takes longer than that when the suites of the workspace run in parallel, so allow more; a
// passing assertion still returns at once, only a real failure waits the full time.
configure({ asyncUtilTimeout: 5_000 })

// jsdom has no matchMedia; default to a light OS preference.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
}
Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})
