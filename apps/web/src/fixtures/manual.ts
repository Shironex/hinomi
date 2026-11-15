import type { DeploymentItem, SourceDto } from '@hinomi/shared'
import { deploymentItem } from './builders'
import { FIXED_NOW, REPOS, SOURCES, ago } from './dataset'

// The `manual` fixture scenario: the default instance plus a manual list of three deployments the
// platform sources do not know about (a legacy host, a partner box and an image only job).
// Fictional names only.

const SOURCE_ID = 9
const source = { id: SOURCE_ID, kind: 'manual', name: 'Manual list' } as const

export const MANUAL_SOURCE: SourceDto = {
  ...SOURCES[0]!,
  id: SOURCE_ID,
  kind: 'manual',
  name: 'Manual list',
  baseUrl: null,
  hasToken: false,
  lastOkAt: new Date(FIXED_NOW - 15 * 60 * 1000).toISOString(),
  deploymentCount: 3,
}

const entry = (over: Partial<DeploymentItem>): DeploymentItem =>
  deploymentItem({
    source,
    status: 'unknown',
    lastDeployedAt: null,
    firstSeenAt: ago(24 * 3),
    lastSeenAt: ago(0.25),
    mapping: 'none',
    repos: [],
    coverage: { alerts: 'none', blindSpots: [], covered: false, imageOnly: false },
    openFindings: { critical: 0, high: 0, moderate: 0, low: 0 },
    exposed: 0,
    openBlindSpots: 0,
    ...over,
  })

export const MANUAL_DEPLOYMENTS: DeploymentItem[] = [
  entry({
    id: 901,
    name: 'partner-portal',
    kind: 'application',
    externalId: 'manual-1',
    reach: 'public',
    server: 'legacy-1',
    domains: ['https://partners.example.com'],
    image: 'registry.example.com/partner-portal:2.3.1',
    gitRepository: 'kestrel-co/billing',
    gitBranch: 'release',
    mapping: 'auto',
    repos: [REPOS.billing],
    coverage: { alerts: 'enabled', blindSpots: [], covered: true, imageOnly: false },
  }),
  entry({
    id: 902,
    name: 'report-worker',
    kind: 'application',
    externalId: 'manual-2',
    reach: 'internal',
    server: 'legacy-1',
    domains: [],
    image: null,
    gitRepository: 'kestrel-co/ingest',
    gitBranch: 'main',
    mapping: 'auto',
    repos: [REPOS.ingest],
    coverage: { alerts: 'enabled', blindSpots: [], covered: true, imageOnly: false },
  }),
  entry({
    id: 903,
    name: 'status-mirror',
    kind: 'application',
    externalId: 'manual-3',
    reach: 'unknown',
    server: null,
    domains: ['status-mirror.example.com'],
    image: 'registry.example.com/status-mirror:0.9.0',
    gitRepository: null,
    gitBranch: null,
    coverage: { alerts: 'none', blindSpots: [], covered: false, imageOnly: true },
  }),
]
