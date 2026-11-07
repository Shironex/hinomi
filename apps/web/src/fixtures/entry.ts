/**
 * Fixture mode entry (`vite --mode fixtures` or `vite build --mode fixtures`, see
 * vite.config.ts). It swaps in for src/main.tsx only in that mode, so a normal build never
 * contains it.
 *
 * Before the app loads it freezes the clock, formats dates in UTC, and answers every /api request from the fictional
 * dataset in ./dataset, so the UI renders the same pixels on every run without a server and
 * never shows a real host or project. Any request outside /api still goes to the network
 * as usual (only the app's own assets are requested).
 *
 * `?fixture=setup` in the first URL serves a first run instead of a configured instance, and
 * `?fixture=webhook-on` (and the other `webhook-*` names) the GitHub webhook in that state.
 * `?fixture=update` shows a newer release available next to the running version.
 * `?fixture=runner-new`, `runner-error` and `local-off` show the webhook runner settings and the
 * local runner in those states.
 */
import { FIXED_NOW } from './dataset'
import { fixtureRoute, isFixtureScenario, type FixtureScenario } from './routes'

if (import.meta.env.MODE !== 'fixtures') {
  throw new Error('The fixture entry only runs in fixture mode (vite --mode fixtures)')
}

function freezeClock(now: number) {
  const RealDate = Date
  // Only an argument-less Date (and Date.now) reads the clock; every other form is unchanged.
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(now)
      else super(...args)
    }
    static override now() {
      return now
    }
  }
  globalThis.Date = FixedDate as DateConstructor
}

/** Formatted dates and clock times read UTC, so captures match on every machine and OS. */
function pinTimeZone(timeZone: string) {
  type Args = ConstructorParameters<typeof Intl.DateTimeFormat>
  const withZone = ([locales, options]: Args | []): Args => [locales, { timeZone, ...options }]
  Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
    construct: (Real, args: Args) => new Real(...withZone(args)),
    apply: (Real, _this, args: Args) => Real(...withZone(args)),
  })
}

function installFixtureApi(scenario: FixtureScenario) {
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : input.toString()
    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return realFetch(input, init)
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const reply = fixtureRoute(
      method,
      url,
      scenario,
      raw ? (JSON.parse(raw) as unknown) : undefined,
    )
    return Promise.resolve(
      reply.body === undefined
        ? new Response(null, { status: reply.status })
        : Response.json(reply.body, { status: reply.status }),
    )
  }
}

const requested = new URLSearchParams(window.location.search).get('fixture')
const scenario: FixtureScenario = isFixtureScenario(requested) ? requested : 'default'

freezeClock(FIXED_NOW)
pinTimeZone('UTC')
installFixtureApi(scenario)
document.documentElement.dataset.fixtures = scenario

// Load the real entry only after the fakes are in place.
void import('../main')
