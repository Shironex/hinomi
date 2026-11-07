import type {
  DeploymentDetail,
  DeploymentItem,
  DeploymentRef,
  FindingDetail,
  FindingListItem,
  FindingsResponse,
  FixesResponse,
  FixItem,
  OverviewResponse,
  RepoRef,
} from '@hinomi/shared'

// Fictional builders shared by the component tests and fixture mode: kestrel-co repos,
// example.dev domains, edge servers. Each returns one valid API object; pass overrides.

export const T0 = '2026-11-01T10:00:00.000Z'

export function repoRef(over: Partial<RepoRef> = {}): RepoRef {
  const name = over.name ?? 'storefront'
  return {
    id: 1,
    owner: 'kestrel-co',
    name,
    fullName: `kestrel-co/${name}`,
    archived: false,
    alertsEnabled: true,
    lastScannedAt: T0,
    ...over,
  }
}

export function deploymentRef(over: Partial<DeploymentRef> = {}): DeploymentRef {
  return {
    id: 1,
    name: 'storefront-web',
    kind: 'application',
    reach: 'public',
    server: 'edge-1',
    domains: ['https://shop.example.dev'],
    ...over,
  }
}

export function findingItem(over: Partial<FindingListItem> = {}): FindingListItem {
  return {
    id: 1,
    kind: 'advisory',
    rank: 100,
    tier: 'exposed',
    factors: { severity: 'critical', runtime: true, deployed: true, public: true },
    unscored: false,
    stopped: false,
    patchedInLockfile: false,
    state: 'open',
    stateReason: null,
    stateUntil: null,
    stateUntilNewAdvisory: false,
    scope: 'runtime',
    sources: ['github', 'osv'],
    blindSpotType: null,
    coverageNote: null,
    advisory: {
      id: 1,
      advisoryKey: 'GHSA-7q2m-48vx-hc3r',
      ghsaId: 'GHSA-7q2m-48vx-hc3r',
      cveIds: ['CVE-2026-41187'],
      ecosystem: 'npm',
      packageName: 'tessera',
      severity: 'critical',
      cvssScore: 9.8,
      summary: 'Remote code execution through crafted server action payloads',
      url: 'https://github.com/advisories/GHSA-7q2m-48vx-hc3r',
      firstPatchedVersion: '14.2.9',
    },
    installedVersion: '14.2.3',
    repo: repoRef(),
    deployments: [deploymentRef()],
    firstSeenAt: T0,
    lastSeenAt: T0,
    fixedAt: null,
    ...over,
  }
}

export function blindSpotItem(over: Partial<FindingListItem> = {}): FindingListItem {
  return findingItem({
    id: 9,
    kind: 'blind_spot',
    tier: 'blind_spot',
    factors: { severity: 'critical', runtime: true, deployed: true, public: true },
    sources: [],
    blindSpotType: 'alerts_disabled',
    advisory: null,
    installedVersion: null,
    repo: repoRef({ id: 2, name: 'docs', alertsEnabled: false }),
    deployments: [
      deploymentRef({ id: 3, name: 'docs-site', domains: ['https://docs.example.dev'] }),
    ],
    ...over,
  })
}

/** An image only deployment: a coverage note, ranked below every advisory. */
export function coverageNoteItem(over: Partial<FindingListItem> = {}): FindingListItem {
  return findingItem({
    id: 12,
    kind: 'coverage_note',
    rank: 0.2,
    tier: 'coverage',
    factors: { severity: 'low', runtime: true, deployed: true, public: true },
    sources: [],
    coverageNote: 'image_only',
    advisory: null,
    installedVersion: null,
    repo: null,
    deployments: [deploymentRef({ id: 8, name: 'status-board', domains: [] })],
    ...over,
  })
}

export function findingsResponse(
  items: FindingListItem[],
  over: Partial<FindingsResponse> = {},
): FindingsResponse {
  return {
    items,
    total: items.length,
    offset: 0,
    limit: 50,
    nextOffset: null,
    group: 'none',
    groups: [],
    ...over,
  }
}

export function overview(over: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    funnel: {
      total: 4917,
      deployed: 1186,
      runtime: 402,
      criticalOrHigh: 37,
      public: 19,
      exposed: 2,
      needsAction: 1,
      dismissedUpstream: 0,
    },
    blindSpots: { total: 1, deployed: 1, public: 1, needsAction: 1 },
    funnelReach: {
      total: { repos: 64, apps: 31 },
      deployed: { repos: 22, apps: 31 },
      runtime: { repos: 19, apps: 27 },
      criticalOrHigh: { repos: 9, apps: 12 },
      public: { repos: 4, apps: 6 },
      exposed: { repos: 2, apps: 2 },
    },
    tierSeverity: {
      blind_spot: { critical: 1, high: 0, moderate: 0, low: 0 },
      exposed: { critical: 1, high: 1, moderate: 0, low: 0 },
      internal: { critical: 12, high: 30, moderate: 60, low: 16 },
      public_low: { critical: 0, high: 0, moderate: 200, low: 65 },
      dev: { critical: 40, high: 210, moderate: 400, low: 134 },
      not_deployed: { critical: 300, high: 1200, moderate: 1800, low: 431 },
      patched: { critical: 0, high: 0, moderate: 0, low: 0 },
      coverage: { critical: 0, high: 0, moderate: 0, low: 3 },
    },
    tiers: {
      blind_spot: 1,
      exposed: 2,
      internal: 118,
      public_low: 265,
      dev: 784,
      not_deployed: 3731,
      patched: 0,
      coverage: 3,
    },
    lastScan: {
      id: 1,
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: T0,
      finishedAt: T0,
      durationMs: 1000,
      sourceResults: {},
      findingsOpened: 2,
      findingsFixed: 0,
      error: null,
    },
    nextScanAt: null,
    sources: [
      {
        id: 1,
        kind: 'coolify',
        name: 'main',
        status: 'ok',
        lastOkAt: T0,
        lastErrorAt: null,
        lastError: null,
      },
      {
        id: 2,
        kind: 'github',
        name: 'kestrel-co',
        status: 'error',
        lastOkAt: null,
        lastErrorAt: T0,
        lastError: 'Bad credentials',
      },
      {
        id: null,
        kind: 'osv',
        name: 'osv',
        status: 'ok',
        lastOkAt: T0,
        lastErrorAt: null,
        lastError: null,
      },
    ],
    recentActivity: [
      {
        id: 5,
        findingId: 1,
        type: 'snooze_expired',
        fromState: 'snoozed',
        toState: 'open',
        reason: null,
        until: null,
        untilNewAdvisory: false,
        actor: 'system',
        at: T0,
        finding: {
          id: 1,
          kind: 'advisory',
          title: 'tessera GHSA-7q2m-48vx-hc3r',
          severity: 'critical',
          repo: 'kestrel-co/storefront',
        },
      },
    ],
    topFixes: [],
    ...over,
  }
}

export function findingDetail(over: Partial<FindingDetail> = {}): FindingDetail {
  const base = findingItem()
  return {
    ...base,
    advisory: {
      ...base.advisory!,
      aliases: [],
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      vulnerableRanges: ['>= 14.0.0, < 14.2.9'],
      publishedAt: T0,
      withdrawnAt: null,
      description: null,
    },
    versions: {
      installed: '14.2.3',
      firstPatched: '14.2.9',
      vulnerableRanges: ['>= 14.0.0, < 14.2.9'],
    },
    dependency: {
      scope: 'runtime',
      manifestPaths: ['pnpm-lock.yaml'],
      path: null,
      pathSource: 'manifest',
    },
    notifications: [],
    sameFixClears: 0,
    history: [
      {
        id: 1,
        findingId: 1,
        type: 'opened',
        fromState: null,
        toState: 'open',
        reason: null,
        until: null,
        untilNewAdvisory: false,
        actor: 'system',
        at: T0,
      },
    ],
    ...over,
  }
}

export function deploymentItem(over: Partial<DeploymentItem> = {}): DeploymentItem {
  return {
    ...deploymentRef(),
    source: { id: 1, kind: 'coolify', name: 'main' },
    externalId: 'app-1',
    status: 'running:healthy',
    image: 'storefront:4f2c91a',
    gitRepository: 'kestrel-co/storefront',
    gitBranch: 'main',
    lastDeployedAt: T0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    mapping: 'auto',
    repos: [repoRef()],
    coverage: { alerts: 'enabled', blindSpots: [], covered: true, imageOnly: false },
    openFindings: { critical: 1, high: 2, moderate: 9, low: 0 },
    exposed: 1,
    openBlindSpots: 0,
    ...over,
  }
}

export function deploymentDetail(over: Partial<DeploymentDetail> = {}): DeploymentDetail {
  return {
    ...deploymentItem(),
    watchPaths: ['src/**', 'Dockerfile'],
    overrides: [],
    findings: [findingItem()],
    ...over,
  }
}

/** One bump: tessera to 14.2.9 clears the exposed finding and two more in another repo. */
export function fixItem(over: Partial<FixItem> = {}): FixItem {
  return {
    key: 'npm:tessera:14.2.9',
    ecosystem: 'npm',
    packageName: 'tessera',
    target: '14.2.9',
    mixedTargets: false,
    findings: {
      total: 3,
      byTier: {
        blind_spot: 0,
        exposed: 1,
        internal: 2,
        public_low: 0,
        dev: 0,
        not_deployed: 0,
        patched: 0,
        coverage: 0,
      },
      bySeverity: { critical: 3, high: 0, moderate: 0, low: 0 },
    },
    findingIds: [1, 21, 22],
    bestTier: 'exposed',
    exposedCritical: true,
    repos: [
      { repo: repoRef(), target: '14.2.9', findings: 1 },
      { repo: repoRef({ id: 4, name: 'ledger' }), target: '14.2.9', findings: 2 },
    ],
    apps: [deploymentRef()],
    ...over,
  }
}

export function fixesResponse(items: FixItem[], over: Partial<FixesResponse> = {}): FixesResponse {
  return { items, total: items.length, offset: 0, limit: 25, nextOffset: null, ...over }
}
