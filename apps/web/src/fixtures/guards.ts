import {
  COOLIFY_GUARD_CAPABILITIES,
  GUARD_CHECKS,
  GUARD_COPY,
  guardEvidenceSchema,
  type CheckOverride,
  type CheckOverrideRef,
  type DeploymentGuard,
  type DeploymentItem,
  type DeploymentRef,
  type FindingListItem,
  type FindingTier,
  type GuardCheck,
  type GuardEvidenceInput,
  type GuardLevel,
  type GuardsResponse,
  type OverviewResponse,
  type RepoRef,
  type SupportLine,
} from '@hinomi/shared'
import { findingItem } from './builders'

// Guard findings of fixture mode: every check at every level it can produce, two checks turned
// off (one per deployment, one per repo), and the guards panel of each deployment. Fictional
// like the rest: kestrel-co repos, example.dev domains, edge and core servers.

type Severity = FindingListItem['factors']['severity']

export interface GuardWorld {
  apps: Record<
    | 'storefront'
    | 'auth'
    | 'docs'
    | 'billing'
    | 'search'
    | 'proxy'
    | 'status'
    | 'marketing'
    | 'admin'
    | 'ingest'
    | 'db',
    DeploymentRef
  >
  repos: Record<
    | 'storefront'
    | 'auth'
    | 'billing'
    | 'search'
    | 'ingest'
    | 'cli'
    | 'docs'
    | 'status'
    | 'admin'
    | 'marketing',
    RepoRef
  >
  ago: (hours: number) => string
}

const COMMIT = '4f2c91a7d3e85b60c19f2a4e7d8b3c5a6f0e1d92'

const node = (line: string, eolFrom: string, daysLeft: number, latest: string): SupportLine => ({
  product: 'nodejs',
  line,
  eolFrom,
  isEol: daysLeft < 0,
  isEoas: true,
  latest,
  basis: 'security',
  daysLeft,
})

interface GuardInput {
  id: number
  check: GuardCheck
  level: GuardLevel
  severity: Severity
  tier: FindingTier
  evidence: GuardEvidenceInput
  repo: RepoRef | null
  deployments: DeploymentRef[]
  rank: number
  stopped?: boolean
  override?: CheckOverrideRef
  firstSeenHours?: number
}

function guardFinding(world: GuardWorld, input: GuardInput): FindingListItem {
  const evidence = guardEvidenceSchema.parse(input.evidence)
  const copy = GUARD_COPY[input.check]
  const reach = input.deployments.some((d) => d.reach === 'public')
  const running = input.deployments.length > 0 && !input.stopped
  return findingItem({
    id: input.id,
    kind: 'guard',
    rank: input.rank,
    tier: input.tier,
    factors: {
      severity: input.severity,
      runtime: running,
      deployed: running,
      public: reach && running,
    },
    stopped: input.stopped ?? false,
    sources: [],
    scope: 'runtime',
    state: input.override ? 'accepted' : 'open',
    stateReason: input.override?.reason ?? null,
    advisory: null,
    installedVersion: null,
    repo: input.repo,
    deployments: input.deployments,
    guard: {
      check: input.check,
      level: input.level,
      evidence,
      title: copy.title,
      explanation: copy.explanation[input.level] ?? copy.question,
      fixText: copy.fix[input.level] ?? '',
      override: input.override ?? null,
    },
    firstSeenAt: world.ago(input.firstSeenHours ?? 30),
    lastSeenAt: world.ago(0.25),
  })
}

export function guardFindings(world: GuardWorld): FindingListItem[] {
  const { apps, repos, ago } = world
  const g = (input: GuardInput) => guardFinding(world, input)
  return [
    g({
      id: 101,
      check: 'docker_socket',
      level: 'fail',
      severity: 'critical',
      tier: 'exposed',
      rank: 39,
      repo: repos.status,
      deployments: [apps.status],
      evidence: {
        check: 'docker_socket',
        mounts: [
          {
            source: 'compose',
            hostPath: '/var/run/docker.sock',
            containerPath: '/var/run/docker.sock',
            readOnly: true,
            service: 'uptime',
          },
        ],
        checked: ['compose', 'file_storage', 'persistent_storage'],
      },
    }),
    g({
      id: 102,
      check: 'root_user',
      level: 'fail',
      severity: 'high',
      tier: 'exposed',
      rank: 38,
      repo: repos.storefront,
      deployments: [apps.storefront],
      evidence: {
        check: 'root_user',
        source: 'dockerfile',
        user: 'root',
        path: 'Dockerfile',
        line: 31,
        from: 'node:22-bookworm-slim',
        stage: 'runtime',
        commit: COMMIT,
        services: [],
      },
    }),
    g({
      id: 103,
      check: 'shared_network',
      level: 'fail',
      severity: 'high',
      tier: 'exposed',
      rank: 38,
      repo: repos.billing,
      deployments: [apps.billing],
      evidence: {
        check: 'shared_network',
        basis: 'coolify_destination',
        network: 'coolify',
        destination: { server: 'edge-1', type: 'standalone_docker', id: 1 },
        project: 'billing',
        peers: [
          { deploymentId: 11, name: 'billing-db', project: 'ledger', database: true },
          { deploymentId: 6, name: 'image-proxy', project: 'media', database: false },
        ],
      },
    }),
    g({
      id: 104,
      check: 'root_user',
      level: 'warn',
      severity: 'moderate',
      tier: 'public_low',
      rank: 27,
      repo: repos.auth,
      deployments: [apps.auth],
      evidence: {
        check: 'root_user',
        source: 'dockerfile',
        user: null,
        path: 'apps/gateway/Dockerfile',
        line: 18,
        from: 'node:20-alpine',
        stage: null,
        commit: COMMIT.replace('4f2c', 'b81e'),
        services: [],
      },
    }),
    g({
      id: 105,
      check: 'shared_network',
      level: 'warn',
      severity: 'moderate',
      tier: 'public_low',
      rank: 27,
      repo: repos.search,
      deployments: [apps.search],
      evidence: {
        check: 'shared_network',
        basis: 'external_network',
        network: 'shared-edge',
        destination: null,
        project: 'search',
        peers: [{ deploymentId: 3, name: 'docs-site', project: 'docs', database: false }],
      },
    }),
    g({
      id: 106,
      check: 'watch_paths_skip',
      level: 'warn',
      severity: 'moderate',
      tier: 'public_low',
      rank: 27,
      repo: repos.docs,
      deployments: [apps.docs],
      evidence: {
        check: 'watch_paths_skip',
        patterns: ['src/**', 'content/**'],
        autoDeploy: true,
        checked: ['Dockerfile', 'package.json', 'pnpm-lock.yaml', '.nvmrc', 'src/main.ts'],
        skipped: ['Dockerfile', 'package.json', 'pnpm-lock.yaml', '.nvmrc'],
      },
    }),
    g({
      id: 107,
      check: 'root_user',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.2,
      repo: null,
      deployments: [apps.proxy],
      evidence: {
        check: 'root_user',
        source: 'none',
        user: null,
        path: null,
        line: null,
        from: 'registry.example.dev/imgproxy:3.21',
        stage: null,
        commit: null,
        services: [],
        reason:
          'This source does not report the container user: the service runs a registry image with no Dockerfile, run options or compose user.',
      },
    }),
    g({
      id: 108,
      check: 'docker_socket',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.2,
      repo: null,
      deployments: [apps.proxy],
      evidence: {
        check: 'docker_socket',
        mounts: [],
        checked: [],
        reason: "This source does not report the container's mounts for one click services.",
      },
    }),
    g({
      id: 109,
      check: 'framework_support',
      level: 'fail',
      severity: 'high',
      tier: 'not_deployed',
      rank: 3,
      stopped: true,
      repo: repos.marketing,
      deployments: [apps.marketing],
      firstSeenHours: 24 * 40,
      evidence: {
        check: 'framework_support',
        ref: 'preview',
        frameworks: [
          {
            packageName: 'next',
            ecosystem: 'npm',
            purl: 'pkg:npm/next',
            installedVersion: '13.5.6',
            manifestPath: 'package.json',
            result: 'fail',
            support: {
              product: 'nextjs',
              line: '13',
              eolFrom: '2025-06-24',
              isEol: true,
              isEoas: true,
              latest: '13.5.11',
              basis: 'security',
              daysLeft: -499,
            },
            target: { line: '15', latest: '15.5.4' },
          },
        ],
      },
    }),
    g({
      id: 110,
      check: 'framework_support',
      level: 'warn',
      severity: 'moderate',
      tier: 'internal',
      rank: 17,
      repo: repos.admin,
      deployments: [apps.admin],
      evidence: {
        check: 'framework_support',
        ref: 'main',
        frameworks: [
          {
            packageName: 'next',
            ecosystem: 'npm',
            purl: 'pkg:npm/next',
            installedVersion: '14.2.15',
            manifestPath: 'package.json',
            result: 'warn',
            support: {
              product: 'nextjs',
              line: '14',
              eolFrom: '2026-12-26',
              isEol: false,
              isEoas: true,
              latest: '14.2.33',
              basis: 'security',
              daysLeft: 51,
            },
            target: { line: '15', latest: '15.5.4' },
          },
        ],
      },
    }),
    g({
      id: 111,
      check: 'framework_support',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.2,
      repo: repos.search,
      deployments: [apps.search],
      evidence: {
        check: 'framework_support',
        ref: 'main',
        frameworks: [
          {
            packageName: 'django',
            ecosystem: 'PyPI',
            purl: 'pkg:pypi/django',
            installedVersion: '6.3.0a1',
            manifestPath: 'uv.lock',
            result: 'unknown',
            support: null,
            target: null,
          },
        ],
        reason:
          'django 6.3.0a1 matches no release line in the support data: a pre-release, or a line newer than the cached copy.',
      },
    }),
    g({
      id: 112,
      check: 'runtime_support',
      level: 'fail',
      severity: 'high',
      tier: 'internal',
      rank: 19,
      repo: repos.ingest,
      deployments: [apps.ingest],
      evidence: {
        check: 'runtime_support',
        ref: 'main',
        runtimes: [
          {
            runtime: 'node',
            result: 'fail',
            pin: {
              runtime: 'node',
              source: 'dockerfile',
              path: 'Dockerfile',
              line: 1,
              raw: 'node:18-alpine',
              lineName: '18',
              floating: false,
            },
            support: node('18', '2025-04-30', -554, '18.20.8'),
            resolvedTo: null,
            target: { line: '24', latest: '24.11.0' },
            fixHints: [
              { path: 'Dockerfile', line: 1, from: 'node:18-alpine', to: 'node:24-alpine' },
              { path: '.nvmrc', line: 1, from: '18', to: '24' },
              {
                path: '.github/workflows/ci.yml',
                line: 22,
                from: 'node-version: 18',
                to: 'node-version: 24',
              },
            ],
          },
        ],
      },
    }),
    g({
      id: 113,
      check: 'runtime_support',
      level: 'warn',
      severity: 'moderate',
      tier: 'public_low',
      rank: 27,
      repo: repos.storefront,
      deployments: [apps.storefront],
      evidence: {
        check: 'runtime_support',
        ref: 'main',
        runtimes: [
          {
            runtime: 'node',
            result: 'warn',
            pin: {
              runtime: 'node',
              source: 'dockerfile',
              path: 'Dockerfile',
              line: 1,
              raw: 'node:22-bookworm-slim',
              lineName: '22',
              floating: false,
            },
            support: node('22', '2027-04-30', 176, '22.21.1'),
            resolvedTo: null,
            target: { line: '24', latest: '24.11.0' },
            fixHints: [
              {
                path: 'Dockerfile',
                line: 1,
                from: 'node:22-bookworm-slim',
                to: 'node:24-bookworm-slim',
              },
              { path: '.nvmrc', line: 1, from: '20', to: '24' },
            ],
          },
          {
            runtime: 'bun',
            result: 'pass',
            pin: {
              runtime: 'bun',
              source: 'package_manager',
              path: 'package.json',
              line: 5,
              raw: 'bun@1.3.1',
              lineName: '1',
              floating: false,
            },
            support: {
              product: 'bun',
              line: '1',
              eolFrom: null,
              isEol: false,
              isEoas: null,
              latest: '1.3.2',
              basis: 'release_cycle',
              daysLeft: null,
            },
            resolvedTo: null,
            target: null,
            fixHints: [],
          },
        ],
      },
    }),
    g({
      id: 114,
      check: 'runtime_support',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.2,
      repo: repos.auth,
      deployments: [apps.auth],
      evidence: {
        check: 'runtime_support',
        ref: 'release',
        runtimes: [
          {
            runtime: 'node',
            result: 'unknown',
            pin: {
              runtime: 'node',
              source: 'node_version',
              path: '.node-version',
              line: 1,
              raw: '25.9',
              lineName: null,
              floating: false,
            },
            support: null,
            resolvedTo: null,
            target: null,
            fixHints: [],
          },
        ],
        reason:
          'The pin 25.9 in .node-version matches no Node line in the support data: a typo, or a line newer than the cached copy.',
      },
    }),
    g({
      id: 115,
      check: 'runtime_pins_disagree',
      level: 'warn',
      severity: 'low',
      tier: 'public_low',
      rank: 26,
      repo: repos.storefront,
      deployments: [apps.storefront],
      evidence: {
        check: 'runtime_pins_disagree',
        ref: 'main',
        runtimes: [
          {
            runtime: 'node',
            result: 'warn',
            productionLine: '22',
            pins: [
              {
                runtime: 'node',
                source: 'dockerfile',
                path: 'Dockerfile',
                line: 1,
                raw: 'node:22-bookworm-slim',
                lineName: '22',
                floating: false,
              },
              {
                runtime: 'node',
                source: 'nvmrc',
                path: '.nvmrc',
                line: 1,
                raw: '20',
                lineName: '20',
                floating: false,
              },
              {
                runtime: 'node',
                source: 'setup_node',
                path: '.github/workflows/ci.yml',
                line: 18,
                raw: '20.x',
                lineName: '20',
                floating: false,
              },
              {
                runtime: 'node',
                source: 'engines',
                path: 'package.json',
                line: 9,
                raw: '>=20',
                lineName: '20',
                floating: false,
              },
            ],
            fixHints: [
              { path: '.nvmrc', line: 1, from: '20', to: '22' },
              { path: '.github/workflows/ci.yml', line: 18, from: '20.x', to: '22.x' },
            ],
          },
        ],
      },
    }),
    g({
      id: 116,
      check: 'action_runtime',
      level: 'fail',
      severity: 'moderate',
      tier: 'public_low',
      rank: 27,
      repo: repos.billing,
      deployments: [apps.billing],
      evidence: {
        check: 'action_runtime',
        actions: [
          {
            action: 'kestrel-co/release-notes@v1',
            using: 'node16',
            result: 'fail',
            support: node('16', '2023-09-11', -1151, '16.20.2'),
            workflowPath: '.github/workflows/release.yml',
            workflowLine: 41,
          },
          {
            action: 'kestrel-co/deploy-ping@v2',
            using: 'node20',
            result: 'fail',
            support: node('20', '2026-04-30', -189, '20.19.5'),
            workflowPath: '.github/workflows/deploy.yml',
            workflowLine: 12,
          },
          {
            action: 'actions/checkout@v5',
            using: 'node24',
            result: 'pass',
            support: node('24', '2028-04-30', 907, '24.11.0'),
            workflowPath: '.github/workflows/ci.yml',
            workflowLine: 9,
          },
        ],
      },
    }),
    g({
      id: 117,
      check: 'action_runtime',
      level: 'warn',
      severity: 'low',
      tier: 'not_deployed',
      rank: 1,
      repo: repos.cli,
      deployments: [],
      evidence: {
        check: 'action_runtime',
        actions: [
          {
            action: 'self',
            using: 'node22',
            result: 'warn',
            support: node('22', '2027-04-30', 176, '22.21.1'),
            workflowPath: null,
            workflowLine: null,
          },
        ],
      },
    }),
    g({
      id: 118,
      check: 'root_user',
      level: 'fail',
      severity: 'high',
      tier: 'internal',
      rank: 18,
      repo: repos.admin,
      deployments: [apps.admin],
      firstSeenHours: 24 * 12,
      override: {
        id: 1,
        scope: 'deployment',
        reason:
          'Vendor admin image binds port 80 inside the container; reachable over the VPN only.',
        createdAt: ago(24 * 9),
      },
      evidence: {
        check: 'root_user',
        source: 'docker_inspect',
        user: '',
        path: null,
        line: null,
        from: 'registry.example.dev/admin-console:5.2',
        stage: null,
        commit: null,
        services: [],
      },
    }),
    g({
      id: 119,
      check: 'watch_paths_skip',
      level: 'warn',
      severity: 'moderate',
      tier: 'internal',
      rank: 16,
      repo: repos.ingest,
      deployments: [apps.ingest],
      firstSeenHours: 24 * 20,
      override: {
        id: 2,
        scope: 'repo',
        reason: 'Ingest deploys by hand after every tagged release, never on push.',
        createdAt: ago(24 * 18),
      },
      evidence: {
        check: 'watch_paths_skip',
        patterns: ['worker/**'],
        autoDeploy: true,
        checked: ['Dockerfile', 'package.json', 'pnpm-lock.yaml', 'worker/index.ts'],
        skipped: ['Dockerfile', 'package.json', 'pnpm-lock.yaml'],
      },
    }),
    g({
      id: 120,
      check: 'shared_network',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.1,
      repo: null,
      deployments: [apps.db],
      evidence: {
        check: 'shared_network',
        basis: null,
        network: null,
        destination: null,
        project: 'ledger',
        peers: [],
        reason: 'This source does not report which networks the container is on.',
      },
    }),
    g({
      id: 121,
      check: 'watch_paths_skip',
      level: 'unknown',
      severity: 'low',
      tier: 'coverage',
      rank: 0.2,
      repo: null,
      deployments: [apps.proxy],
      evidence: {
        check: 'watch_paths_skip',
        patterns: [],
        autoDeploy: null,
        checked: [],
        skipped: [],
        reason: 'This source has no watch paths for a service run from a registry image.',
      },
    }),
  ]
}

const isGuard = (f: FindingListItem) => f.kind === 'guard' && f.guard !== null

/** Evidence a passing check keeps, so the panel can say what the pass is based on. */
function passEvidence(check: GuardCheck, item: DeploymentItem): GuardEvidenceInput | null {
  if (check === 'root_user') {
    return {
      check,
      source: 'dockerfile',
      user: 'node',
      path: 'Dockerfile',
      line: 27,
      from: 'node:24-alpine',
      stage: 'runtime',
      commit: COMMIT,
      services: [],
    }
  }
  if (check === 'docker_socket') {
    return { check, mounts: [], checked: ['run_options', 'persistent_storage', 'file_storage'] }
  }
  if (check === 'watch_paths_skip' && item.repos.length) {
    return {
      check,
      patterns: ['src/**', 'package.json', 'pnpm-lock.yaml', 'Dockerfile'],
      autoDeploy: true,
      checked: ['Dockerfile', 'package.json', 'pnpm-lock.yaml'],
      skipped: [],
    }
  }
  return null
}

const REPO_CHECKS: ReadonlySet<GuardCheck> = new Set([
  'runtime_support',
  'runtime_pins_disagree',
  'action_runtime',
])

/** GET /deployments/:id `guards`: every check on the deployment, then its open blind spot types. */
export function deploymentGuardsFor(
  item: DeploymentItem,
  findings: readonly FindingListItem[],
): DeploymentGuard[] {
  const repoIds = new Set(item.repos.map((r) => r.id))
  const guards = findings.filter(isGuard)
  const out: DeploymentGuard[] = GUARD_CHECKS.map((check) => {
    const repoCheck = REPO_CHECKS.has(check)
    const found = guards.find(
      (f) =>
        f.guard!.check === check &&
        (repoCheck
          ? f.repo !== null && repoIds.has(f.repo.id)
          : f.deployments.some((d) => d.id === item.id)),
    )
    if (found) {
      return {
        check,
        result: found.guard!.level,
        evidence: found.guard!.evidence,
        findingId: found.id,
        override: found.guard!.override,
      }
    }
    // Repo checks need a repo; a database runs no repo code.
    const runs = repoCheck || check === 'framework_support' ? item.repos.length > 0 : true
    const evidence = runs ? passEvidence(check, item) : null
    return {
      check,
      result: runs ? 'pass' : null,
      evidence: evidence ? guardEvidenceSchema.parse(evidence) : null,
      findingId: null,
      override: null,
    }
  })
  const archived = findings.find(
    (f) =>
      f.kind === 'blind_spot' &&
      f.blindSpotType === 'archived_deployed' &&
      f.deployments.some((d) => d.id === item.id),
  )
  if (archived) {
    out.push({
      check: 'archived_deployed',
      result: 'fail',
      evidence: null,
      findingId: archived.id,
      override: null,
    })
  }
  return out
}

/** Overview `guardCounts`: guard findings not fixed (turned off ones included), per check and level. */
export function guardCountsOf(
  findings: readonly FindingListItem[],
): OverviewResponse['guardCounts'] {
  const out = Object.fromEntries(
    GUARD_CHECKS.map((check) => [check, { warn: 0, fail: 0, unknown: 0 }]),
  ) as OverviewResponse['guardCounts']
  for (const f of findings) {
    if (!isGuard(f) || f.state === 'fixed') continue
    out[f.guard!.check][f.guard!.level]++
  }
  return out
}

/** Nav count: warn or fail on a running deployment, not snoozed, accepted or turned off. */
export function guardNavCount(findings: readonly FindingListItem[]): number {
  return findings.filter(
    (f) =>
      isGuard(f) &&
      (f.guard!.level === 'fail' || f.guard!.level === 'warn') &&
      (f.state === 'open' || f.state === 'fixing') &&
      f.deployments.length > 0 &&
      !f.stopped,
  ).length
}

/** GET /overrides: the overrides behind the turned off fixture findings. */
export function overridesOf(findings: readonly FindingListItem[]): CheckOverride[] {
  return findings.flatMap((f) => {
    const o = f.guard?.override
    if (!o || !f.guard) return []
    return [
      {
        id: o.id,
        check: f.guard.check,
        deployment: o.scope === 'deployment' ? (f.deployments[0] ?? null) : null,
        repo: o.scope === 'repo' ? f.repo : null,
        reason: o.reason,
        createdAt: o.createdAt,
        updatedAt: o.createdAt,
      },
    ]
  })
}

/** GET /guards: the registry as the server builds it, with the fixture counts. */
export function guardsResponseOf(findings: readonly FindingListItem[]): GuardsResponse {
  const counts = guardCountsOf(findings)
  const overrides = overridesOf(findings)
  return {
    items: GUARD_CHECKS.map((check) => {
      const coolify = COOLIFY_GUARD_CAPABILITIES[check]
      return {
        check,
        title: GUARD_COPY[check].title,
        reads: GUARD_COPY[check].reads,
        levels: [...GUARD_COPY[check].levels],
        capabilities: coolify ? { coolify } : { github: 'full' },
        counts: counts[check],
        overrides: overrides.filter((o) => o.check === check).length,
      }
    }),
  }
}
