import { vi } from 'vitest'

type Handler = (body: unknown, url: URL) => unknown

export interface ApiCall {
  method: string
  path: string
  search: URLSearchParams
  body: unknown
}

/** `reply(400, {...})` for a non 2xx answer; any other return value is sent as JSON with 200. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}
export const reply = (status: number, body?: unknown) => new Reply(status, body)

/**
 * Stubs fetch with a small router keyed by "METHOD /path" (path without /api
 * and without the query string). Unknown routes answer 404, so a test fails
 * loudly when a screen calls something it did not expect.
 */
export function mockApi(routes: Record<string, unknown>) {
  const calls: ApiCall[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : input.toString()
    const url = new URL(href, 'http://hinomi.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/api/, '')
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ method, path, search: url.searchParams, body })
    const key = `${method} ${path}`
    if (!(key in routes)) {
      return Promise.resolve(
        Response.json(
          { error: { code: 'not_found', message: `No mock for ${key}` } },
          { status: 404 },
        ),
      )
    }
    const route = routes[key]
    const result = typeof route === 'function' ? (route as Handler)(body, url) : route
    if (result instanceof Reply) {
      return Promise.resolve(
        result.body === undefined
          ? new Response(null, { status: result.status })
          : Response.json(result.body, { status: result.status }),
      )
    }
    return Promise.resolve(Response.json(result))
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls,
    called: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  }
}

// Fictional fixtures --------------------------------------------------------

const at = '2026-11-05T10:00:00.000Z'

export const coolifySource = {
  id: 1,
  kind: 'coolify' as const,
  name: 'coolify.example.dev',
  baseUrl: 'https://coolify.example.dev',
  enabled: true,
  auth: 'token' as const,
  appId: null,
  installationId: null,
  hasToken: true,
  lastOkAt: at,
  lastErrorAt: null,
  lastError: null,
  createdAt: at,
  updatedAt: at,
}

export const githubSource = {
  ...coolifySource,
  id: 2,
  kind: 'github' as const,
  name: 'GitHub',
  baseUrl: null,
}

export const scanRun = (over: Record<string, unknown> = {}) => ({
  id: 7,
  trigger: 'manual',
  status: 'running',
  startedAt: at,
  finishedAt: null,
  durationMs: null,
  sourceResults: {},
  findingsOpened: 0,
  findingsFixed: 0,
  error: null,
  ...over,
})

export const channel = {
  id: '0b8f6a52-3c1e-4d7a-9a52-5d2f0c1e7b11',
  kind: 'webhook' as const,
  name: 'Incident bot',
  enabled: true,
  minSeverity: 'high' as const,
  url: 'https://hooks.example.dev/...b7c1',
  urlEncrypted: true,
}

const repo = (id: number, fullName: string) => ({
  id,
  owner: fullName.split('/')[0] ?? '',
  name: fullName.split('/')[1] ?? '',
  fullName,
  archived: false,
  alertsEnabled: true,
  lastScannedAt: at,
})

export const deployment = (over: Record<string, unknown> = {}) => ({
  id: 11,
  name: 'storefront-web',
  kind: 'application',
  reach: 'public',
  server: 'edge-1',
  domains: ['shop.example.dev'],
  source: { id: 1, kind: 'coolify', name: 'coolify.example.dev' },
  externalId: 'app-11',
  status: 'running:healthy',
  image: null,
  gitRepository: 'kestrel-co/storefront',
  gitBranch: 'main',
  lastDeployedAt: at,
  firstSeenAt: at,
  lastSeenAt: at,
  mapping: 'auto',
  repos: [repo(21, 'kestrel-co/storefront')],
  coverage: { alerts: 'enabled', blindSpots: [], covered: true, imageOnly: false },
  openFindings: { critical: 0, high: 0, moderate: 0, low: 0 },
  exposed: 0,
  openBlindSpots: 0,
  ...over,
})

/** A configured instance: both sources, settings, no channels, one deployment. */
export function configuredRoutes(): Record<string, unknown> {
  return {
    'GET /health': { status: 'ok' },
    'GET /shell/nav-counts': { needsAction: 0, deployments: 1, alerts: 0, activeFixRuns: null },
    'GET /shell/scan-status': { state: 'idle', lastScanAt: at, nextScanAt: null },
    'GET /onboarding': { finished: true, alertsSkipped: false },
    'GET /sources': { sources: [coolifySource, githubSource], canStoreTokens: true },
    'GET /settings': { scanIntervalMinutes: 360, osvEnabled: true, includeAccountRepos: false },
    'GET /notifications/channels': { items: [] },
    'GET /notifications/settings': { publicBaseUrl: null, digestHour: 8 },
    'GET /deployments': { items: [deployment()] },
    'GET /repos': { items: [repo(21, 'kestrel-co/storefront'), repo(22, 'kestrel-co/shop-api')] },
  }
}

/** A scan status in progress: run 7 fetching alerts, 2 of 5 repos. */
export const scanningStatus = (over: Record<string, unknown> = {}) => ({
  state: 'scanning',
  scanRunId: 7,
  startedAt: at,
  phase: 'alerts',
  done: 2,
  total: 5,
  skipped: [],
  ...over,
})
