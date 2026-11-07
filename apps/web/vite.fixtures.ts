import type { Plugin } from 'vite'

/** The Vite mode that turns fixture mode on: `vite --mode fixtures`, `vite build --mode fixtures`. */
export const FIXTURES_MODE = 'fixtures'

const APP_ENTRY = '/src/main.tsx'
const FIXTURES_ENTRY = '/src/fixtures/entry.ts'

/**
 * Fixture mode for screenshots and demos: in the `fixtures` mode only, index.html boots through
 * src/fixtures/entry.ts, which freezes the clock and answers /api from fictional data before
 * the app loads. Any other mode (the default `production` build, `vite` in development) keeps
 * src/main.tsx, so nothing under src/fixtures reaches a normal build. There is no env var or
 * runtime flag to flip it on by accident.
 */
export function fixturesMode(): Plugin {
  let enabled = false
  return {
    name: 'hinomi-fixtures-mode',
    configResolved(config) {
      enabled = config.mode === FIXTURES_MODE
    },
    transformIndexHtml: {
      // Before Vite resolves the entry script, so the swap works in dev and in a build.
      order: 'pre',
      handler(html) {
        if (!enabled) return html
        if (!html.includes(APP_ENTRY)) {
          throw new Error(`Fixture mode could not find ${APP_ENTRY} in index.html`)
        }
        return html.replace(APP_ENTRY, FIXTURES_ENTRY)
      },
    },
  }
}
