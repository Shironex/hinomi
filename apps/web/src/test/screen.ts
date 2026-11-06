import { vi } from 'vitest'

/**
 * The test setup answers every media query with false (a phone). This makes width queries
 * match, so split views show the list and the detail side by side. Undone by
 * vi.unstubAllGlobals.
 */
export function wideScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
