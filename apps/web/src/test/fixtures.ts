import { mockApi, reply } from './mock-api'
import { T0 } from '@/fixtures/builders'

export * from '@/fixtures/builders'

/** Shell endpoints of a configured instance, quiet, so a view test only mocks its own calls. */
export function shellRoutes(): Record<string, unknown> {
  return {
    'GET /shell/nav-counts': {
      needsAction: null,
      deployments: null,
      alerts: null,
      activeFixRuns: null,
    },
    'GET /shell/scan-status': { state: 'idle', lastScanAt: T0, nextScanAt: null },
    'GET /repos': { items: [] },
  }
}

/** mockApi with the shell answered; `routes` win over the defaults. */
export function mockViews(routes: Record<string, unknown>) {
  return mockApi({ ...shellRoutes(), ...routes })
}

export function apiError(status: number, code: string, message: string) {
  return reply(status, { error: { code, message } })
}
