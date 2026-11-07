import type {
  AccessStatus,
  DeployRecord,
  DeploymentDetail,
  DeploymentItem,
  DeploymentRef,
  FindingDetail,
  FindingEvent,
  FindingListItem,
  FindingTier,
  FixItem,
  NotifyChannel,
  OverviewResponse,
  RepoRef,
  ScanRun,
  SeverityCounts,
  SourceDto,
} from '@hinomi/shared'
import {
  deploymentItem,
  deploymentRef,
  emptyGuardCounts,
  findingDetail,
  findingItem,
  fixItem,
  overview,
  repoRef,
} from './builders'

// The fictional instance fixture mode serves: Kestrel Co runs eleven apps on one Coolify
// with three servers, and GitHub plus OSV.dev report on nine repos. Every name, host and
// advisory is made up; example.dev is reserved for documentation.

/** The fixed clock of fixture mode: Thursday 5 November 2026, 10:00 UTC. */
export const FIXED_NOW = Date.UTC(2026, 10, 5, 10, 0, 0)

const HOUR = 3_600_000
/** An ISO time `hours` before the fixed clock (negative for the future). */
export const ago = (hours: number) => new Date(FIXED_NOW - hours * HOUR).toISOString()

// ---------------------------------------------------------------------------
// Repos and apps

const repo = (id: number, name: string, over: Partial<RepoRef> = {}) =>
  repoRef({ id, name, lastScannedAt: ago(0.25), ...over })

export const REPOS = {
  storefront: repo(1, 'storefront'),
  auth: repo(2, 'auth'),
  docs: repo(3, 'docs', { alertsEnabled: false }),
  billing: repo(4, 'billing'),
  search: repo(5, 'search'),
  status: repo(6, 'status'),
  admin: repo(7, 'admin'),
  ingest: repo(8, 'ingest'),
  marketing: repo(9, 'marketing', { archived: true }),
  cli: repo(10, 'kestrel-cli'),
}

const app = (
  id: number,
  name: string,
  server: string,
  domains: string[],
  over: Partial<DeploymentRef> = {},
) => deploymentRef({ id, name, server, domains, ...over })

const APPS = {
  storefront: app(1, 'storefront-web', 'edge-1', [
    'https://shop.example.dev',
    'https://www.example.dev',
  ]),
  auth: app(2, 'auth-gateway', 'edge-1', ['https://auth.example.dev']),
  docs: app(3, 'docs-site', 'edge-2', ['https://docs.example.dev']),
  billing: app(4, 'billing-api', 'edge-1', ['https://billing.example.dev']),
  search: app(5, 'search-api', 'edge-2', ['https://search.example.dev']),
  proxy: app(6, 'image-proxy', 'edge-1', ['https://img.example.dev'], { kind: 'service' }),
  status: app(7, 'status-page', 'edge-2', ['https://status.example.dev']),
  marketing: app(8, 'marketing-preview', 'edge-2', ['https://preview.example.dev']),
  admin: app(9, 'admin-console', 'core-1', ['https://admin.internal.example.dev'], {
    reach: 'internal',
  }),
  ingest: app(10, 'ingest-worker', 'core-1', [], { reach: 'internal' }),
  db: app(11, 'billing-db', 'core-1', [], { kind: 'database', reach: 'internal' }),
}

// ---------------------------------------------------------------------------
// Findings

interface AdvisoryInput {
  key: string
  pkg: string
  severity: 'critical' | 'high' | 'moderate' | 'low'
  cvss: number
  summary: string
  patched: string | null
  installed: string
  cve?: string
}

function advisory(id: number, input: AdvisoryInput): Partial<FindingListItem> {
  return {
    advisory: {
      id,
      advisoryKey: input.key,
      ghsaId: input.key,
      cveIds: input.cve ? [input.cve] : [],
      ecosystem: 'npm',
      packageName: input.pkg,
      severity: input.severity,
      cvssScore: input.cvss,
      summary: input.summary,
      url: `https://github.com/advisories/${input.key}`,
      firstPatchedVersion: input.patched,
    },
    installedVersion: input.installed,
    factors: { severity: input.severity, runtime: true, deployed: true, public: true },
  }
}

const finding = (id: number, rank: number, over: Partial<FindingListItem>) =>
  findingItem({ id, rank, firstSeenAt: ago(50), lastSeenAt: ago(0.25), ...over })

const blindSpot: Partial<FindingListItem> = {
  kind: 'blind_spot',
  tier: 'blind_spot',
  sources: [],
  advisory: null,
  installedVersion: null,
}

export const FINDINGS: FindingListItem[] = [
  finding(1, 100, {
    ...advisory(1, {
      key: 'GHSA-7q2m-48vx-hc3r',
      cve: 'CVE-2026-41187',
      pkg: 'tessera',
      severity: 'critical',
      cvss: 9.8,
      summary: 'Remote code execution through crafted server action payloads',
      patched: '14.2.9',
      installed: '14.2.3',
    }),
    repo: REPOS.storefront,
    deployments: [APPS.storefront],
  }),
  finding(2, 99, {
    ...blindSpot,
    blindSpotType: 'alerts_disabled',
    factors: { severity: 'critical', runtime: true, deployed: true, public: true },
    repo: REPOS.docs,
    deployments: [APPS.docs],
    firstSeenAt: ago(144),
  }),
  finding(3, 97, {
    ...advisory(3, {
      key: 'GHSA-f3vq-9m2c-x7wp',
      pkg: 'authline',
      severity: 'critical',
      cvss: 9.1,
      summary: 'Session token signature skipped when the alg header is none',
      patched: '3.1.4',
      installed: '3.0.9',
    }),
    repo: REPOS.auth,
    deployments: [APPS.auth],
    firstSeenAt: ago(20),
  }),
  finding(4, 95, {
    ...advisory(4, {
      key: 'GHSA-2hxw-c84j-r5mq',
      pkg: 'imgsharp',
      severity: 'critical',
      cvss: 9.0,
      summary: 'Heap overflow when decoding crafted AVIF headers',
      patched: null,
      installed: '0.33.1',
    }),
    repo: REPOS.search,
    deployments: [APPS.search],
    firstSeenAt: ago(70),
  }),
  finding(5, 90, {
    ...advisory(5, {
      key: 'GHSA-m8rk-5wq3-jv2f',
      pkg: 'quillparse',
      severity: 'high',
      cvss: 8.6,
      summary: 'Prototype pollution in front matter parsing can lead to code execution',
      patched: '2.0.7',
      installed: '2.0.4',
    }),
    // Dependabot is off for docs, so only OSV.dev sees this one.
    sources: ['osv'],
    repo: REPOS.docs,
    deployments: [APPS.docs],
    firstSeenAt: ago(30),
  }),
  finding(6, 88, {
    ...advisory(6, {
      key: 'GHSA-9wcp-hq7v-4x3m',
      pkg: 'tarstream',
      severity: 'high',
      cvss: 7.5,
      summary: 'Path traversal when extracting archives that contain symlinks',
      patched: '1.4.6',
      installed: '1.4.1',
    }),
    repo: REPOS.billing,
    deployments: [APPS.billing],
    firstSeenAt: ago(96),
  }),
  finding(7, 87, {
    ...advisory(7, {
      key: 'GHSA-q4jm-7c2x-p9vh',
      pkg: 'tessera',
      severity: 'high',
      cvss: 7.5,
      summary: 'Cache poisoning through a forged middleware header',
      patched: '14.2.9',
      installed: '14.2.3',
    }),
    repo: REPOS.storefront,
    deployments: [APPS.storefront],
    firstSeenAt: ago(50),
  }),
  finding(8, 86, {
    ...advisory(8, {
      key: 'GHSA-x2rf-v8kq-3m7c',
      pkg: 'yamlette',
      severity: 'high',
      cvss: 7.8,
      summary: 'Unsafe tag resolution allows code execution',
      patched: '5.1.2',
      installed: '5.0.0',
    }),
    repo: REPOS.billing,
    deployments: [APPS.billing],
    state: 'snoozed',
    stateReason: 'Waiting on the vendor release notes',
    stateUntil: ago(-72),
    firstSeenAt: ago(120),
  }),
  finding(9, 70, {
    ...advisory(9, {
      key: 'GHSA-c7pv-3q9w-hm4r',
      pkg: 'proxyline',
      severity: 'critical',
      cvss: 8.9,
      summary: 'Server side request forgery through redirect following',
      patched: '4.11.3',
      installed: '4.11.0',
    }),
    tier: 'internal',
    factors: { severity: 'critical', runtime: true, deployed: true, public: false },
    repo: REPOS.ingest,
    deployments: [APPS.ingest],
    firstSeenAt: ago(28 * 24),
  }),
  finding(10, 64, {
    ...advisory(10, {
      key: 'GHSA-r5hx-2mvq-8c4w',
      pkg: 'streamtap',
      severity: 'high',
      cvss: 7.1,
      summary: 'Regular expression denial of service in the line splitter',
      patched: '2.2.0',
      installed: '2.1.0',
    }),
    tier: 'internal',
    factors: { severity: 'high', runtime: true, deployed: true, public: false },
    repo: REPOS.admin,
    deployments: [APPS.admin],
    state: 'accepted',
    stateReason: 'Internal only, behind the VPN',
    firstSeenAt: ago(15 * 24),
  }),
  finding(11, 30, {
    ...advisory(11, {
      key: 'GHSA-h6wq-4p8m-v2xr',
      pkg: 'marked-lite',
      severity: 'moderate',
      cvss: 5.3,
      summary: 'Cross site scripting through unescaped link titles',
      patched: '4.3.1',
      installed: '4.2.0',
    }),
    tier: 'public_low',
    repo: REPOS.status,
    deployments: [APPS.status],
  }),
  finding(12, 12, {
    ...advisory(12, {
      key: 'GHSA-3jxv-w7cq-m9p2',
      pkg: 'testbench',
      severity: 'high',
      cvss: 7.4,
      summary: 'Arbitrary file read through the dev server',
      patched: '2.1.8',
      installed: '2.1.2',
    }),
    tier: 'dev',
    scope: 'dev',
    factors: { severity: 'high', runtime: false, deployed: true, public: true },
    repo: REPOS.storefront,
    deployments: [APPS.storefront],
  }),
  finding(13, 4, {
    ...advisory(13, {
      key: 'GHSA-8vqm-r2wc-5h7x',
      pkg: 'argkit',
      severity: 'critical',
      cvss: 9.3,
      summary: 'Command injection through unquoted shell arguments',
      patched: '1.9.2',
      installed: '1.8.0',
    }),
    tier: 'not_deployed',
    factors: { severity: 'critical', runtime: true, deployed: false, public: false },
    repo: REPOS.cli,
    deployments: [],
  }),
  finding(14, 2, {
    ...advisory(14, {
      key: 'GHSA-p2mc-6x9v-q4wr',
      pkg: 'cookie-jar-lite',
      severity: 'high',
      cvss: 7.4,
      summary: 'Cookie parsing allows header injection',
      patched: '0.9.3',
      installed: '0.9.3',
    }),
    tier: 'patched',
    patchedInLockfile: true,
    repo: REPOS.storefront,
    deployments: [APPS.storefront],
  }),
  finding(15, 0.2, {
    kind: 'coverage_note',
    tier: 'coverage',
    coverageNote: 'image_only',
    sources: [],
    advisory: null,
    installedVersion: null,
    factors: { severity: 'low', runtime: true, deployed: true, public: true },
    repo: null,
    deployments: [APPS.proxy],
  }),
]

const event = (
  id: number,
  findingId: number,
  type: string,
  hours: number,
  over: Partial<FindingEvent> = {},
): FindingEvent => ({
  id,
  findingId,
  type,
  fromState: null,
  toState: null,
  reason: null,
  until: null,
  untilNewAdvisory: false,
  actor: 'system',
  at: ago(hours),
  ...over,
})

const DESCRIPTION = [
  'A crafted request to a server action endpoint makes the package deserialize attacker',
  'controlled data and run code in the server process. Every version before the patch is',
  'affected; the patch validates the payload before decoding it.',
].join(' ')

/** Same bump, same answer: how many open findings each package bump clears. */
const SAME_FIX: Record<string, number> = { tessera: 5, tarstream: 3, authline: 1, quillparse: 2 }

export function detailFor(item: FindingListItem): FindingDetail {
  const base = findingDetail()
  const a = item.advisory
  const lead = item.id === 1
  return {
    ...base,
    ...item,
    advisory: a
      ? {
          ...a,
          aliases: a.cveIds,
          cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
          vulnerableRanges: [`< ${a.firstPatchedVersion ?? '99.0.0'}`],
          publishedAt: ago(80),
          withdrawnAt: null,
          description: lead ? DESCRIPTION : null,
        }
      : null,
    versions: {
      installed: item.installedVersion,
      firstPatched: a?.firstPatchedVersion ?? null,
      vulnerableRanges: a ? [`< ${a.firstPatchedVersion ?? '99.0.0'}`] : [],
    },
    dependency: {
      scope: item.scope,
      manifestPaths: a ? ['pnpm-lock.yaml'] : [],
      path: a ? (lead ? ['site-kit', 'tessera'] : [a.packageName]) : null,
      pathSource: a ? 'lockfile' : 'package',
    },
    sameFixClears: a && item.state === 'open' ? (SAME_FIX[a.packageName] ?? 1) : 0,
    plan: null,
    history: lead
      ? [
          event(4, 1, 'snooze_expired', 2, { fromState: 'snoozed', toState: 'open' }),
          event(3, 1, 'snoozed', 26, {
            actor: 'user',
            fromState: 'open',
            toState: 'snoozed',
            reason: 'Waiting on the release notes',
            until: ago(2),
          }),
          event(2, 1, 'reporters_changed', 40),
          event(1, 1, 'opened', 50, { toState: 'open' }),
        ]
      : [event(item.id * 10, item.id, 'opened', 50, { toState: 'open' })],
    notifications: lead
      ? [
          {
            channelId: '6f1c2a54-7d3e-4b8a-9c21-0e5f7a9b3d11',
            channelName: 'ops alerts',
            channelKind: 'discord',
            event: 'reopened',
            eventId: 4,
            sentAt: ago(2),
          },
        ]
      : [],
  }
}

// ---------------------------------------------------------------------------
// Fixes

const tiers = (over: Partial<Record<FindingTier, number>>): Record<FindingTier, number> => ({
  blind_spot: 0,
  exposed: 0,
  internal: 0,
  released: 0,
  public_low: 0,
  dev: 0,
  not_deployed: 0,
  patched: 0,
  coverage: 0,
  ...over,
})

const severity = (critical: number, high: number, moderate = 0, low = 0): SeverityCounts => ({
  critical,
  high,
  moderate,
  low,
})

export const FIXES: FixItem[] = [
  fixItem({
    findings: {
      total: 5,
      byTier: tiers({ exposed: 2, internal: 3 }),
      bySeverity: severity(3, 2),
    },
    findingIds: [1, 7],
    repos: [
      { repo: REPOS.storefront, target: '14.2.9', findings: 2, plan: null },
      { repo: REPOS.admin, target: '14.2.9', findings: 3, plan: null },
    ],
    apps: [APPS.storefront, APPS.admin],
  }),
  fixItem({
    key: 'npm:authline:3.1.4',
    packageName: 'authline',
    target: '3.1.4',
    findings: { total: 1, byTier: tiers({ exposed: 1 }), bySeverity: severity(1, 0) },
    findingIds: [3],
    repos: [{ repo: REPOS.auth, target: '3.1.4', findings: 1, plan: null }],
    apps: [APPS.auth],
  }),
  fixItem({
    key: 'npm:tarstream:1.4.6',
    packageName: 'tarstream',
    target: '1.4.6',
    exposedCritical: false,
    findings: { total: 3, byTier: tiers({ exposed: 1, internal: 2 }), bySeverity: severity(0, 3) },
    findingIds: [6],
    repos: [
      { repo: REPOS.billing, target: '1.4.6', findings: 1, plan: null },
      { repo: REPOS.ingest, target: '1.4.6', findings: 2, plan: null },
    ],
    apps: [APPS.billing, APPS.ingest],
  }),
  fixItem({
    key: 'npm:quillparse:2.0.7',
    packageName: 'quillparse',
    target: '2.0.7',
    exposedCritical: false,
    findings: { total: 2, byTier: tiers({ exposed: 1, internal: 1 }), bySeverity: severity(0, 2) },
    findingIds: [5],
    repos: [
      { repo: REPOS.docs, target: '2.0.7', findings: 1, plan: null },
      { repo: REPOS.admin, target: '2.0.7', findings: 1, plan: null },
    ],
    apps: [APPS.docs, APPS.admin],
  }),
  fixItem({
    key: 'npm:imgsharp:none',
    packageName: 'imgsharp',
    target: null,
    findings: { total: 1, byTier: tiers({ exposed: 1 }), bySeverity: severity(1, 0) },
    findingIds: [4],
    repos: [{ repo: REPOS.search, target: null, findings: 1, plan: null }],
    apps: [APPS.search],
  }),
]

// ---------------------------------------------------------------------------
// Deployments

interface DeploymentInput {
  ref: DeploymentRef
  repos: RepoRef[]
  image: string | null
  git: string | null
  branch?: string
  deployedHours: number
  status?: string
  mapping?: DeploymentItem['mapping']
  coverage?: Partial<DeploymentItem['coverage']>
}

function deployment(input: DeploymentInput): DeploymentItem {
  const open = FINDINGS.filter(
    (f) =>
      f.kind === 'advisory' &&
      f.state !== 'fixed' &&
      f.deployments.some((d) => d.id === input.ref.id),
  )
  const count = (sev: string) => open.filter((f) => f.factors.severity === sev).length
  const blind = FINDINGS.filter(
    (f) => f.kind === 'blind_spot' && f.deployments.some((d) => d.id === input.ref.id),
  )
  return deploymentItem({
    ...input.ref,
    source: { id: 1, kind: 'coolify', name: 'main' },
    externalId: `app-${input.ref.id}`,
    status: input.status ?? 'running:healthy',
    image: input.image,
    gitRepository: input.git,
    gitBranch: input.git ? (input.branch ?? 'main') : null,
    lastDeployedAt: ago(input.deployedHours),
    firstSeenAt: ago(60 * 24),
    lastSeenAt: ago(0.25),
    mapping: input.mapping ?? (input.repos.length ? 'auto' : 'none'),
    repos: input.repos,
    coverage: {
      alerts: input.repos.length
        ? input.repos.every((r) => r.alertsEnabled)
          ? 'enabled'
          : 'disabled'
        : 'none',
      blindSpots: blind.flatMap((f) => (f.blindSpotType ? [f.blindSpotType] : [])),
      covered: blind.length === 0 && (input.repos.length > 0 || input.ref.kind === 'database'),
      imageOnly: false,
      ...input.coverage,
    },
    openFindings: {
      critical: count('critical'),
      high: count('high'),
      moderate: count('moderate'),
      low: count('low'),
    },
    exposed: open.filter((f) => f.tier === 'exposed' && f.state === 'open').length,
    openBlindSpots: blind.length,
  })
}

export const DEPLOYMENTS: DeploymentItem[] = [
  deployment({
    ref: APPS.storefront,
    repos: [REPOS.storefront],
    image: 'storefront:4f2c91a',
    git: 'kestrel-co/storefront',
    deployedHours: 72,
  }),
  deployment({
    ref: APPS.auth,
    repos: [REPOS.auth],
    image: 'auth:b81e0d2',
    git: 'kestrel-co/auth',
    branch: 'release',
    deployedHours: 144,
  }),
  deployment({
    ref: APPS.docs,
    repos: [REPOS.docs],
    image: 'docs:19aa3c7',
    git: 'kestrel-co/docs',
    deployedHours: 14 * 24,
  }),
  deployment({
    ref: APPS.billing,
    repos: [REPOS.billing],
    image: 'billing:7c03e55',
    git: 'kestrel-co/billing',
    deployedHours: 24,
  }),
  deployment({
    ref: APPS.search,
    repos: [REPOS.search],
    image: 'search:e2d4410',
    git: 'kestrel-co/search',
    deployedHours: 30 * 24,
  }),
  deployment({
    ref: APPS.proxy,
    repos: [],
    image: 'registry.example.dev/imgproxy:3.21',
    git: null,
    deployedHours: 8 * 24,
    coverage: { imageOnly: true, covered: false },
  }),
  deployment({
    ref: APPS.status,
    repos: [REPOS.status],
    image: 'status:a0b7f19',
    git: 'kestrel-co/status',
    deployedHours: 96,
  }),
  deployment({
    ref: APPS.marketing,
    repos: [REPOS.marketing],
    image: 'marketing:5512cd0',
    git: 'kestrel-co/marketing-site',
    branch: 'preview',
    deployedHours: 90 * 24,
    status: 'exited:unhealthy',
    mapping: 'override',
  }),
  deployment({
    ref: APPS.admin,
    repos: [REPOS.admin],
    image: 'admin:0c9e3b1',
    git: 'kestrel-co/admin',
    deployedHours: 120,
  }),
  deployment({
    ref: APPS.ingest,
    repos: [REPOS.ingest],
    image: 'ingest:66f1a20',
    git: 'kestrel-co/ingest',
    deployedHours: 48,
  }),
  deployment({
    ref: APPS.db,
    repos: [],
    image: 'postgres:16-alpine',
    git: null,
    deployedHours: 40 * 24,
  }),
]

export function deploymentDetailFor(item: DeploymentItem): DeploymentDetail {
  return {
    ...item,
    watchPaths: item.repos.length ? ['src/**', 'package.json', 'Dockerfile'] : null,
    overrides:
      item.mapping === 'override'
        ? [
            {
              repo: REPOS.marketing,
              note: 'Repo was renamed from marketing-site',
              createdAt: ago(80 * 24),
            },
          ]
        : [],
    findings: FINDINGS.filter(
      (f) => f.state !== 'fixed' && f.deployments.some((d) => d.id === item.id),
    ),
    guards: [],
  }
}

export function deploysFor(item: DeploymentItem): DeployRecord[] {
  if (item.kind !== 'application') return []
  const messages = [
    'Bump the checkout copy for the winter sale',
    'Cache product images for a day',
    'Fix the currency rounding on the cart page',
  ]
  return messages.map((message, i) => ({
    id: `${item.id}-${i}`,
    status: 'finished',
    commit: `${(item.id * 7919 + i * 104729).toString(16).padStart(7, '0').slice(0, 7)}`,
    commitMessage: message,
    startedAt: ago((i + 1) * 30),
    finishedAt: ago((i + 1) * 30 - 0.05),
    webhook: true,
    rollback: false,
  }))
}

// ---------------------------------------------------------------------------
// Overview, sources, settings and the shell

const lastScan: ScanRun = {
  id: 42,
  trigger: 'schedule',
  status: 'succeeded',
  startedAt: ago(0.27),
  finishedAt: ago(0.25),
  durationMs: 71_400,
  sourceResults: {
    coolify: { status: 'ok', counts: { deployments: 11 }, durationMs: 1_800 },
    github: { status: 'ok', counts: { repos: 10, alerts: 1_286 }, durationMs: 52_300 },
    osv: { status: 'ok', counts: { lockfiles: 9, advisories: 214 }, durationMs: 17_300 },
  },
  findingsOpened: 2,
  findingsFixed: 3,
  error: null,
}

const count = (tier: FindingTier) => FINDINGS.filter((f) => f.tier === tier).length
const exposedOpen = FINDINGS.filter((f) => f.tier === 'exposed' && f.state === 'open').length

export const OVERVIEW: OverviewResponse = overview({
  funnel: {
    total: 1_286,
    deployed: 412,
    runtime: 198,
    criticalOrHigh: 41,
    public: 9,
    exposed: count('exposed'),
    needsAction: exposedOpen,
    dismissedUpstream: 0,
  },
  blindSpots: { total: 1, deployed: 1, public: 1, needsAction: 1 },
  funnelReach: {
    total: { repos: 10, apps: 11 },
    deployed: { repos: 9, apps: 11 },
    runtime: { repos: 8, apps: 9 },
    criticalOrHigh: { repos: 7, apps: 7 },
    public: { repos: 5, apps: 5 },
    exposed: { repos: 5, apps: 5 },
  },
  tierSeverity: {
    blind_spot: severity(1, 0),
    exposed: severity(3, 4),
    internal: severity(6, 14, 22, 4),
    released: severity(0, 0),
    public_low: severity(0, 0, 41, 12),
    dev: severity(9, 38, 61, 20),
    not_deployed: severity(52, 310, 512, 186),
    patched: severity(0, 1),
    coverage: severity(0, 0, 0, 1),
  },
  tiers: tiers({
    blind_spot: 1,
    exposed: count('exposed'),
    internal: 46,
    public_low: 53,
    dev: 128,
    not_deployed: 1_060,
    patched: 1,
    coverage: 1,
  }),
  lastScan,
  nextScanAt: ago(-5.75),
  sources: [
    {
      id: 1,
      kind: 'coolify',
      name: 'main',
      status: 'ok',
      lastOkAt: ago(0.25),
      lastErrorAt: null,
      lastError: null,
    },
    {
      id: 2,
      kind: 'github',
      name: 'kestrel-co',
      status: 'ok',
      lastOkAt: ago(0.25),
      lastErrorAt: null,
      lastError: null,
    },
    {
      id: null,
      kind: 'osv',
      name: 'osv',
      status: 'ok',
      lastOkAt: ago(0.25),
      lastErrorAt: null,
      lastError: null,
    },
  ],
  recentActivity: [
    {
      ...event(4, 1, 'snooze_expired', 2, { fromState: 'snoozed', toState: 'open' }),
      finding: {
        id: 1,
        kind: 'advisory',
        title: 'tessera GHSA-7q2m-48vx-hc3r',
        severity: 'critical',
        repo: 'kestrel-co/storefront',
      },
    },
    {
      ...event(31, 3, 'opened', 20, { toState: 'open' }),
      finding: {
        id: 3,
        kind: 'advisory',
        title: 'authline GHSA-f3vq-9m2c-x7wp',
        severity: 'critical',
        repo: 'kestrel-co/auth',
      },
    },
    {
      ...event(81, 8, 'snoozed', 26, {
        actor: 'user',
        fromState: 'open',
        toState: 'snoozed',
        reason: 'Waiting on the vendor release notes',
        until: ago(-72),
      }),
      finding: {
        id: 8,
        kind: 'advisory',
        title: 'yamlette GHSA-x2rf-v8kq-3m7c',
        severity: 'high',
        repo: 'kestrel-co/billing',
      },
    },
  ],
  topFixes: FIXES.slice(0, 3),
  guardCounts: emptyGuardCounts(),
})

const source = (over: Partial<SourceDto>): SourceDto => ({
  id: 1,
  kind: 'coolify',
  name: 'main',
  baseUrl: 'https://coolify.example.dev',
  enabled: true,
  auth: 'token',
  appId: null,
  installationId: null,
  hasToken: true,
  lastOkAt: ago(0.25),
  lastErrorAt: null,
  lastError: null,
  repoCount: 0,
  deploymentCount: 0,
  createdAt: ago(60 * 24),
  updatedAt: ago(60 * 24),
  ...over,
})

// Two GitHub sources: the kestrel-co GitHub App reads most repos, and a personal token reads
// the CLI (the app is not installed on it) and also sees storefront and auth, so those two can be
// switched. See ./repo-sources for which source reads each repo.
export const SOURCES: SourceDto[] = [
  source({ deploymentCount: DEPLOYMENTS.length }),
  source({
    id: 2,
    kind: 'github',
    name: 'kestrel-co',
    baseUrl: null,
    auth: 'github_app',
    appId: '1048576',
    installationId: '52428800',
    // Eight scanned repos and the thirteen that only have fix plans (see ./repo-sources).
    repoCount: 21,
  }),
  source({
    id: 3,
    kind: 'github',
    name: 'mara-kestrel',
    baseUrl: null,
    auth: 'token',
    repoCount: 2,
    createdAt: ago(24 * 9),
    updatedAt: ago(24 * 9),
  }),
]

export const CHANNELS: NotifyChannel[] = [
  {
    id: '6f1c2a54-7d3e-4b8a-9c21-0e5f7a9b3d11',
    kind: 'discord',
    name: 'ops alerts',
    enabled: true,
    minSeverity: 'high',
    url: 'https://discord.example.dev/...9f2a',
    urlEncrypted: true,
  },
  {
    id: '0b8f6a52-3c1e-4d7a-9a52-5d2f0c1e7b11',
    kind: 'email',
    name: 'Security inbox',
    enabled: true,
    minSeverity: 'critical',
    url: 'smtp.example.dev:587',
    urlEncrypted: true,
    email: {
      host: 'smtp.example.dev',
      port: 587,
      security: 'starttls',
      user: 'hinomi',
      from: 'hinomi@example.dev',
      to: ['security@example.dev'],
      passwordSet: true,
    },
  },
]

export const ACCESS: AccessStatus = {
  state: 'tailscale',
  address: '127.0.0.1',
  forwarded: false,
  via: 'serve',
  login: 'ops@example.dev',
}

export const LAST_SCAN = lastScan
