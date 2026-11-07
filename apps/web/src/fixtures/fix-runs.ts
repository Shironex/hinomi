import {
  FINDING_TIERS,
  FIX_BRANCH,
  isMajorStep,
  MAJORS_BRANCH,
  isFixRunTerminal,
  LOCAL_RUNNER_WARNING,
  renderCallerWorkflow,
  type FindingTier,
  type FixAgentReport,
  type FixCheckResult,
  type FixPlan,
  type FixPlanRef,
  type FixPlanStep,
  type FixPlanUnfixed,
  type FixResultV1,
  type FixRun,
  type FixRunnerKind,
  type FixRunDeployment,
  type FixRunDetail,
  type FixRunState,
  type FixRunVerification,
  type RepoRef,
  type RunnerPermission,
  type RunnerStatus,
} from '@hinomi/shared'
import { repoRef } from './builders'
import { ago, DEPLOYMENTS, REPOS } from './dataset'

// Fix plans, runner statuses and fix runs of the fictional Kestrel Co instance. The runs cover
// every fix run state, spread over repos so each repo has at most one run still going. A few
// extra repos exist only here (mailer, webhooks, payments-sdk, reports, notifier).

const extra = (id: number, name: string) => repoRef({ id, name, lastScannedAt: ago(0.25) })

const R = {
  ...REPOS,
  mailer: extra(11, 'mailer'),
  webhooks: extra(12, 'webhooks'),
  paymentsSdk: extra(13, 'payments-sdk'),
  reports: extra(14, 'reports'),
  notifier: extra(15, 'notifier'),
  exporter: extra(16, 'exporter'),
  scheduler: extra(17, 'scheduler'),
  gateway: extra(18, 'gateway'),
  ledger: extra(19, 'ledger'),
  // The repos of the runner kinds: two on the webhook runner, two on the local runner.
  courier: extra(20, 'courier'),
  beacon: extra(21, 'beacon'),
  forge: extra(22, 'forge'),
  vault: extra(23, 'vault'),
}

/** The release commit callers pin in fixture mode, and an older one an outdated caller pins. */
const LATEST_SHA = '4f1c2a9e8b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a'
const OLD_SHA = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b'

const tiers = (over: Partial<Record<FindingTier, number>> = {}) =>
  Object.fromEntries(FINDING_TIERS.map((t) => [t, over[t] ?? 0])) as Record<FindingTier, number>

// ---------------------------------------------------------------------------
// Plans

interface StepInput {
  pkg: string
  from: string
  to: string
  order: number
  findings: number[]
  advisories: string[]
  byTier?: Partial<Record<FindingTier, number>>
  relationship?: 'direct' | 'transitive'
  manifests?: string[]
  lockfile?: string | null
  manager?: 'pnpm' | 'npm' | 'yarn'
  level?: 'patch' | 'minor' | 'major'
  risky?: boolean
  via?: string[]
}

function step(input: StepInput): FixPlanStep {
  const relationship = input.relationship ?? 'direct'
  const lockfile = input.lockfile === undefined ? 'pnpm-lock.yaml' : input.lockfile
  const manager = input.manager ?? 'pnpm'
  const level = input.level ?? 'patch'
  const risky = input.risky ?? false
  const apply: FixPlanStep['apply'] =
    lockfile === null
      ? { type: 'manual' }
      : relationship === 'transitive'
        ? {
            type: 'override',
            manifest: 'package.json',
            field: manager === 'pnpm' ? 'pnpm.overrides' : 'overrides',
            key: input.pkg,
            value: input.to,
          }
        : {
            type: 'manifest_bump',
            manifests: input.manifests ?? ['package.json'],
            packageName: input.pkg,
            version: input.to,
          }
  const type = apply.type
  return {
    id: `${type}:npm:${input.pkg}:${input.to}:${lockfile ?? 'none'}`,
    order: input.order,
    ecosystem: 'npm',
    packageName: input.pkg,
    relationship,
    lockfile,
    packageManager: lockfile === null ? 'unknown' : manager,
    workspaces: relationship === 'direct' ? ['.'] : [],
    via: input.via ?? [],
    findingIds: input.findings,
    advisories: input.advisories,
    byTier: tiers(input.byTier ?? { exposed: input.findings.length }),
    from: [input.from],
    to: input.to,
    level,
    risk: risky || lockfile === null ? 'risky' : 'safe',
    riskReasons: lockfile === null ? ['unknown_package_manager'] : risky ? ['semver_major'] : [],
    note:
      lockfile === null
        ? 'No lockfile Hinomi reads'
        : risky
          ? 'Semver major: read the changelog'
          : null,
    apply,
    releasedAt: null,
    releaseAge: 'unknown',
  }
}

function unfixed(
  pkg: string,
  installed: string,
  findings: number[],
  advisory: string,
): FixPlanUnfixed {
  return {
    ecosystem: 'npm',
    packageName: pkg,
    relationship: 'direct',
    lockfile: 'pnpm-lock.yaml',
    packageManager: 'pnpm',
    workspaces: ['.'],
    via: [],
    findingIds: findings,
    advisories: [advisory],
    byTier: tiers({ exposed: findings.length }),
    installed: [installed],
    blocker: 'no_patch',
    availableAt: null,
  }
}

function plan(
  repo: RepoRef,
  scanRunId: number,
  steps: FixPlanStep[],
  rest: { unfixed?: FixPlanUnfixed[]; total?: number; previous?: FixPlan['previous'] } = {},
): FixPlan {
  const safe = steps.filter((s) => s.risk === 'safe')
  const ids = (list: FixPlanStep[]) => new Set(list.flatMap((s) => s.findingIds)).size
  const unfixedList = rest.unfixed ?? []
  const unfixedFindings = new Set(unfixedList.flatMap((u) => u.findingIds)).size
  return {
    version: 1,
    repo,
    scanRunId,
    createdAt: ago(0.25),
    projects: [
      { lockfile: 'pnpm-lock.yaml', root: '.', packageManager: 'pnpm', workspaces: ['.'] },
    ],
    steps,
    unfixed: unfixedList,
    summary: {
      findings: {
        total: rest.total ?? ids(steps) + unfixedFindings,
        cleared: ids(steps),
        clearedSafely: ids(safe),
        unfixed: unfixedFindings,
        clearedByTier: tiers({ exposed: ids(safe) }),
        unfixedByTier: tiers({ exposed: unfixedFindings }),
      },
      steps: { safe: safe.length, risky: steps.length - safe.length },
      unfixed: unfixedList.length,
    },
    previous: rest.previous ?? null,
  }
}

const SCAN = 212

/** A semver major the optional agent can take: risky, with a lockfile and a known manager. */
const major = (
  pkg: string,
  from: string,
  to: string,
  order: number,
  findings: number[],
  advisory: string,
) => step({ pkg, from, to, order, findings, advisories: [advisory], level: 'major', risky: true })

const simple = (repo: RepoRef, pkg: string, from: string, to: string, findings: number[]) =>
  plan(repo, SCAN, [
    step({
      pkg,
      from,
      to,
      order: 1,
      findings,
      advisories: [`GHSA-${repo.name.slice(0, 4)}-q7x2-m9vp`],
    }),
  ])

export const PLANS: FixPlan[] = [
  plan(
    R.storefront,
    SCAN,
    [
      step({
        pkg: 'tessera',
        from: '14.2.3',
        to: '14.2.9',
        order: 1,
        findings: [1, 101],
        advisories: ['GHSA-7q2m-48vx-hc3r', 'GHSA-3r8c-p2wq-5mvh'],
        manifests: ['package.json', 'apps/web/package.json'],
      }),
      step({
        pkg: 'cookie-jar-lite',
        from: '1.3.0',
        to: '1.3.2',
        order: 2,
        findings: [102],
        advisories: ['GHSA-c2kq-8m4f-9xwr'],
        level: 'patch',
      }),
      step({
        pkg: 'streamtap',
        from: '0.9.1',
        to: '0.9.4',
        order: 3,
        findings: [103, 104],
        advisories: ['GHSA-x5pv-2hcq-7m3w'],
        relationship: 'transitive',
        via: ['tessera'],
      }),
      step({
        pkg: 'marked-lite',
        from: '4.2.0',
        to: '5.0.1',
        order: 4,
        findings: [105],
        advisories: ['GHSA-m4wq-7v2c-k9px'],
        level: 'major',
        risky: true,
      }),
    ],
    {
      unfixed: [unfixed('yamlette', '2.1.0', [106], 'GHSA-y7v3-q2mc-4hkp')],
      previous: { scanRunId: 205, findings: 4, cleared: 3, stillOpen: 1 },
    },
  ),
  simple(R.auth, 'authline', '3.1.0', '3.1.4', [3]),
  plan(R.docs, SCAN, [
    step({
      pkg: 'quillparse',
      from: '2.0.3',
      to: '2.0.7',
      order: 1,
      findings: [5],
      advisories: ['GHSA-q9r4-v2xm-6hcw'],
    }),
  ]),
  simple(R.billing, 'tarstream', '1.4.2', '1.4.6', [6]),
  plan(
    R.search,
    SCAN,
    [
      step({
        pkg: 'proxyline',
        from: '3.0.4',
        to: '3.0.6',
        order: 1,
        findings: [8],
        advisories: ['GHSA-p3vx-9w2m-q7kc'],
      }),
    ],
    { unfixed: [unfixed('imgsharp', '0.33.1', [4], 'GHSA-i8m2-w4vq-x6pc')] },
  ),
  simple(R.status, 'argkit', '6.1.0', '6.1.3', [9]),
  plan(R.admin, SCAN, [
    step({
      pkg: 'tessera',
      from: '14.2.3',
      to: '14.2.9',
      order: 1,
      findings: [7, 111, 112],
      advisories: ['GHSA-7q2m-48vx-hc3r'],
      byTier: { internal: 3 },
    }),
    step({
      pkg: 'quillparse',
      from: '2.0.3',
      to: '2.0.7',
      order: 2,
      findings: [113],
      advisories: ['GHSA-q9r4-v2xm-6hcw'],
      byTier: { internal: 1 },
    }),
  ]),
  simple(R.ingest, 'tarstream', '1.4.2', '1.4.6', [114, 115]),
  plan(R.cli, SCAN, [
    step({
      pkg: 'testbench',
      from: '8.0.0',
      to: '8.0.2',
      order: 1,
      findings: [116],
      advisories: ['GHSA-t2b4-8vqm-c5wx'],
      byTier: { dev: 1 },
    }),
  ]),
  simple(R.mailer, 'proxyline', '3.0.4', '3.0.6', [117]),
  simple(R.webhooks, 'cookie-jar-lite', '1.3.0', '1.3.2', [118]),
  simple(R.paymentsSdk, 'streamtap', '0.9.1', '0.9.4', [119]),
  simple(R.reports, 'yamlette', '2.0.4', '2.0.9', [120]),
  simple(R.notifier, 'argkit', '6.1.0', '6.1.3', [121]),
  // The repos of the majors agent: only a major upgrade, a major beside a safe step, two majors.
  plan(R.exporter, SCAN, [major('marked-lite', '4.2.0', '5.0.1', 1, [130], 'GHSA-m4wq-7v2c-k9px')]),
  plan(R.scheduler, SCAN, [
    step({
      pkg: 'cookie-jar-lite',
      from: '1.3.0',
      to: '1.3.2',
      order: 1,
      findings: [131],
      advisories: ['GHSA-c2kq-8m4f-9xwr'],
    }),
    major('yamlette', '2.1.0', '3.0.2', 2, [132], 'GHSA-y7v3-q2mc-4hkp'),
  ]),
  plan(R.gateway, SCAN, [
    step({
      pkg: 'streamtap',
      from: '0.9.1',
      to: '0.9.4',
      order: 1,
      findings: [133],
      advisories: ['GHSA-x5pv-2hcq-7m3w'],
    }),
    major('marked-lite', '4.2.0', '5.0.1', 2, [134], 'GHSA-m4wq-7v2c-k9px'),
    major('argkit', '5.4.0', '6.1.3', 3, [135, 136], 'GHSA-a8k2-p3vx-m7qc'),
  ]),
  plan(R.ledger, SCAN, [
    step({
      pkg: 'tarstream',
      from: '1.4.2',
      to: '1.4.6',
      order: 1,
      findings: [137],
      advisories: ['GHSA-t4r5-2q8m-x9vp'],
    }),
    major('quillparse', '1.9.2', '2.0.7', 2, [138], 'GHSA-q9r4-v2xm-6hcw'),
  ]),
  // Repos on the webhook and local runners. Few findings, so they sort last in the list.
  simple(R.courier, 'tarstream', '1.4.2', '1.4.6', [140]),
  simple(R.beacon, 'proxyline', '3.0.4', '3.0.6', [141]),
  simple(R.forge, 'yamlette', '2.0.4', '2.0.9', [142]),
  plan(R.vault, SCAN, [
    step({
      pkg: 'streamtap',
      from: '0.9.1',
      to: '0.9.4',
      order: 1,
      findings: [143],
      advisories: ['GHSA-x5pv-2hcq-7m3w'],
    }),
    major('marked-lite', '4.2.0', '5.0.1', 2, [144], 'GHSA-m4wq-7v2c-k9px'),
  ]),
]

export const PLAN_REFS: (FixPlanRef & { repo: RepoRef })[] = [...PLANS]
  .sort((a, b) => b.summary.findings.cleared - a.summary.findings.cleared)
  .map((p) => ({
    repo: p.repo,
    repoId: p.repo.id,
    scanRunId: p.scanRunId,
    createdAt: p.createdAt,
    summary: p.summary,
  }))

export const planFor = (repoId: number) => PLANS.find((p) => p.repo.id === repoId)

export function planRefFor(repoId: number): FixPlanRef | null {
  const ref = PLAN_REFS.find((p) => p.repoId === repoId)
  if (!ref) return null
  return {
    repoId: ref.repoId,
    scanRunId: ref.scanRunId,
    createdAt: ref.createdAt,
    summary: ref.summary,
  }
}

// ---------------------------------------------------------------------------
// Runs

/** How far a run of each state got, as an index into the time line below. */
const REACHED: Record<FixRunState, number> = {
  pending: 0,
  dispatched: 1,
  queued: 1,
  running: 2,
  nothing_to_do: 3,
  branch_pushed: 4,
  pr_open: 5,
  checks_pending: 5,
  checks_passing: 6,
  checks_failing: 6,
  checks_none: 6,
  closed_unmerged: 6,
  superseded: 6,
  merged: 7,
  deployed: 8,
  verified: 9,
  not_cleared: 9,
  failed: 0,
  cancelled: 2,
  lost: 2,
}

/** Minutes after the dispatch each step happened. */
const OFFSET_MIN = [0, 0.2, 1, 6, 6.5, 7, 19, 60 * 5, 60 * 5.4, 60 * 6]

const hex = (seed: number, length: number) =>
  Array.from({ length }, (_, i) => ((seed * 7 + i * 13) % 16).toString(16)).join('')

interface RunInput {
  id: number
  repo: RepoRef
  state: FixRunState
  /** Hours before the fixed clock the run was created. */
  hours: number
  reason?: string
  checks?: FixCheckResult[]
  /** Overrides the step a failed run reached (default: refused at the dispatch). */
  reached?: number
  pr?: number
  /** `majors` is the agent's own run: its steps are the plan's major upgrades. */
  kind?: 'fix' | 'majors'
  /** What the agent reported, for a majors run that got as far as a result. */
  agent?: FixAgentReport
  /** Where the run went (default GitHub Actions). Other runners have no workflow run. */
  runner?: FixRunnerKind
}

const AGENT_SUMMARY =
  'Bumped marked-lite to 5.0.1 and moved the three call sites to the new parser API. The unit tests and the type check pass; the one snapshot that changed is updated.'

const agentReport = (over: Partial<FixAgentReport> = {}): FixAgentReport => ({
  preset: 'claude-code',
  outcome: 'changed',
  detail: null,
  summary: AGENT_SUMMARY,
  durationMs: 14 * 60_000 + 20_000,
  turns: 37,
  costUsd: 3.42,
  refusedPaths: [],
  ...over,
})

const PASSING: FixCheckResult[] = [
  {
    name: 'lint',
    command: 'pnpm lint',
    status: 'passed',
    durationMs: 18_400,
    output: null,
    truncated: false,
  },
  {
    name: 'typecheck',
    command: 'pnpm typecheck',
    status: 'passed',
    durationMs: 26_100,
    output: null,
    truncated: false,
  },
  {
    name: 'test',
    command: 'pnpm test',
    status: 'passed',
    durationMs: 71_800,
    output: null,
    truncated: false,
  },
  {
    name: 'build',
    command: 'pnpm build',
    status: 'passed',
    durationMs: 48_300,
    output: null,
    truncated: false,
  },
]

const FAILING: FixCheckResult[] = [
  PASSING[0]!,
  PASSING[1]!,
  {
    name: 'test',
    command: 'pnpm test',
    status: 'failed',
    durationMs: 64_200,
    output: [
      ' FAIL  src/checkout/cart.test.ts > cart totals > rounds discounts per line',
      'AssertionError: expected 41.99 to be 42',
      ' - Expected  42',
      ' + Received  41.99',
      '',
      ' Test Files  1 failed | 38 passed (39)',
      '      Tests  1 failed | 412 passed (413)',
    ].join('\n'),
    truncated: false,
  },
  {
    name: 'build',
    command: 'pnpm build',
    status: 'passed',
    durationMs: 47_900,
    output: null,
    truncated: false,
  },
]

/** The result of a majors run: the plan's major upgrades, no install and no checks. */
function majorsResult(input: RunInput, at: (i: number) => string): FixResultV1 | null {
  const p = planFor(input.repo.id)
  const agent = input.agent
  if (!p || !agent) return null
  const changed = agent.outcome === 'changed'
  const majors = p.steps.filter(isMajorStep)
  return {
    schema: 'hinomi.fix-result/1',
    runId: `fr-${input.id}`,
    planScanRunId: p.scanRunId,
    repo: input.repo.fullName,
    baseSha: hex(input.id, 40),
    packageManager: 'pnpm',
    packageManagerVersion: '10.18.0',
    checksMode: 'install',
    steps: majors.map((s) => ({
      id: s.id,
      status: changed ? 'applied' : 'skipped',
      reason: null,
      detail: changed ? null : 'The agent did not change the lockfile for this step',
      files: changed ? ['package.json'] : [],
    })),
    releaseAge: [],
    install: { status: 'skipped', durationMs: 0, output: null, truncated: false },
    checks: [],
    patch: changed
      ? {
          sha256: hex(input.id + 3, 64),
          files: [
            'package.json',
            'pnpm-lock.yaml',
            'src/markdown/render.ts',
            'src/markdown/render.test.ts',
          ],
          insertions: 63,
          deletions: 41,
        }
      : null,
    agent,
    finishedAt: at(3),
  }
}

function result(input: RunInput, at: (i: number) => string): FixResultV1 | null {
  if (input.kind === 'majors') return majorsResult(input, at)
  const p = planFor(input.repo.id)
  if (!p) return null
  const safe = p.steps.filter((s) => s.risk === 'safe' && s.apply.type !== 'manual')
  const full = input.repo.id === R.storefront.id
  const empty = input.state === 'nothing_to_do'
  return {
    schema: 'hinomi.fix-result/1',
    runId: `fr-${input.id}`,
    planScanRunId: p.scanRunId,
    repo: input.repo.fullName,
    baseSha: hex(input.id, 40),
    packageManager: 'pnpm',
    packageManagerVersion: '10.18.0',
    checksMode: full ? 'full' : 'install',
    steps: safe.map((s, i) => ({
      id: s.id,
      status: empty ? 'skipped' : full && i === 1 ? 'skipped' : 'applied',
      reason: empty ? 'already_fixed' : full && i === 1 ? 'too_new' : null,
      detail: null,
      files: empty || (full && i === 1) ? [] : ['package.json'],
    })),
    releaseAge: full
      ? [
          {
            stepId: safe[1]!.id,
            packageName: safe[1]!.packageName,
            version: safe[1]!.to,
            publishedAt: at(0),
            gateDays: 7,
            gateSource: 'pnpm-workspace.yaml',
            status: 'too_new',
            eligibleAt: ago(-24 * 5),
          },
        ]
      : [],
    install: { status: 'ok', durationMs: 22_600, output: null, truncated: false },
    checks: full ? (input.checks ?? PASSING) : [],
    patch: empty
      ? null
      : {
          sha256: hex(input.id + 3, 64),
          files: ['package.json', 'pnpm-lock.yaml'],
          insertions: 14,
          deletions: 11,
        },
    finishedAt: at(3),
  }
}

function run(input: RunInput): FixRun {
  const state = input.state
  const runner = input.runner ?? 'github_actions'
  const reached = input.reached ?? REACHED[state]
  const created = ago(input.hours)
  const at = (i: number) =>
    new Date(Date.parse(created) + (OFFSET_MIN[i] ?? 0) * 60_000).toISOString()
  const has = (i: number) => (reached >= i ? at(i) : null)
  const terminal = isFixRunTerminal(state)
  const prNumber = input.pr ?? 80 + input.id
  const hasPr = reached >= 5 && state !== 'nothing_to_do'
  const merged = reached >= 7
  const closed = state === 'closed_unmerged'
  const ended = terminal ? at(Math.max(reached, 1)) : null
  return {
    id: input.id,
    repoId: input.repo.id,
    plan: { fixPlanId: input.id + 400, scanRunId: SCAN - Math.floor(input.hours / 24), version: 1 },
    runner,
    kind: input.kind ?? 'fix',
    correlationId: `fr-${input.id}`,
    branch: input.kind === 'majors' ? MAJORS_BRANCH : FIX_BRANCH,
    checksMode: input.repo.id === R.storefront.id ? 'full' : 'install',
    state,
    stateReason: input.reason ?? null,
    terminal,
    github:
      runner === 'github_actions' && reached >= 1
        ? { runId: 18_204_000 + input.id, runAttempt: 1 }
        : null,
    headSha: reached >= 4 && state !== 'nothing_to_do' ? hex(input.id + 1, 40) : null,
    pr: hasPr
      ? {
          number: prNumber,
          url: `https://github.com/${input.repo.fullName}/pull/${prNumber}`,
          draft: input.kind === 'majors' || state === 'checks_failing',
          mergeSha: merged ? hex(input.id + 2, 40) : null,
        }
      : null,
    result: reached >= 3 && state !== 'lost' ? result(input, at) : null,
    at: {
      created,
      dispatched: has(1),
      started: has(2),
      completed: has(3),
      pushed: state === 'nothing_to_do' ? null : has(4),
      prOpened: hasPr ? has(5) : null,
      checksUpdated: hasPr && state !== 'checks_none' ? has(6) : null,
      merged: has(7),
      closed: closed ? at(6) : null,
      deployed: has(8),
      rescanned: has(9),
      ended,
      stateChanged: at(Math.max(reached, 0)),
    },
  }
}

const polled = (lastMinutes: number, nextMinutes: number, lastError: string | null = null) => ({
  lastPolledAt: ago(lastMinutes / 60),
  nextPollAt: ago(-nextMinutes / 60),
  lastError,
  pausedUntil: null,
})

type DetailExtra = Partial<Omit<FixRunDetail, keyof FixRun>>

const detail = (r: FixRun, extra: DetailExtra = {}): FixRunDetail => {
  const apps = (extra.deployments ?? []).filter((d) => d.status !== 'other_branch').length
  return {
    ...r,
    tracking: null,
    deployments: [],
    warnings: [],
    // The server computes this from the repo's deployment mappings.
    afterMerge: apps > 0 ? { expects: 'deploy', apps } : { expects: 'rescan_after_merge' },
    verification: null,
    ...extra,
  }
}

/** The run's link to the fixture app that deploys its repo. */
function appLink(
  repo: RepoRef,
  over: Partial<FixRunDeployment> & Pick<FixRunDeployment, 'status'>,
): FixRunDeployment {
  const app = DEPLOYMENTS.find((d) => d.repos.some((r) => r.id === repo.id))
  if (!app) throw new Error(`No fixture app deploys ${repo.fullName}`)
  return {
    deploymentId: app.id,
    name: app.name,
    branch: app.gitBranch,
    deploy: null,
    checkedAt: ago(0.1),
    error: null,
    ...over,
  }
}

const shipped = (seed: number, relation: 'identical' | 'ahead', hours: number) => ({
  id: `dpl-${seed}`,
  commit: hex(seed, 40),
  relation,
  finishedAt: ago(hours),
})

function verification(
  over: Partial<FixRunVerification> & Pick<FixRunVerification, 'after' | 'status' | 'targeted'>,
): FixRunVerification {
  return {
    scan: null,
    cleared: [],
    stillOpen: [],
    new: [],
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    ...over,
  }
}

/** Every fix run, newest first. Run ids grow with time. */
export const RUNS: FixRunDetail[] = [
  detail(run({ id: 49, repo: R.notifier, state: 'pending', hours: 0.01 })),
  // Runs on the webhook and local runners: no workflow run, and no polling before the push.
  detail(run({ id: 60, repo: R.courier, runner: 'webhook', state: 'running', hours: 0.2 })),
  detail(run({ id: 61, repo: R.forge, runner: 'local', state: 'running', hours: 0.1 })),
  detail(
    run({
      id: 62,
      repo: R.courier,
      runner: 'webhook',
      state: 'failed',
      hours: 3,
      reason: 'The webhook runner answered 502, so the plan was not accepted',
    }),
  ),
  detail(run({ id: 63, repo: R.courier, runner: 'webhook', state: 'checks_passing', hours: 26 }), {
    tracking: polled(4, 6),
  }),
  detail(run({ id: 64, repo: R.forge, runner: 'local', state: 'checks_passing', hours: 22 }), {
    tracking: polled(4, 6),
  }),
  detail(
    run({
      id: 65,
      repo: R.forge,
      runner: 'local',
      state: 'failed',
      hours: 40,
      reached: 2,
      reason: 'Hinomi restarted while the local run was in progress',
    }),
  ),
  // The majors agent: only majors in the plan, running; a majors draft PR beside a fix that
  // was verified; an agent that timed out, then a fix run of the same plan that was verified.
  detail(run({ id: 50, repo: R.exporter, kind: 'majors', state: 'running', hours: 0.15 }), {
    tracking: polled(0.2, 0.3),
  }),
  detail(
    run({
      id: 51,
      repo: R.gateway,
      kind: 'majors',
      state: 'pr_open',
      hours: 0.5,
      agent: agentReport({ refusedPaths: ['.github/workflows/ci.yml'] }),
    }),
    { tracking: polled(1, 1) },
  ),
  detail(run({ id: 54, repo: R.ledger, state: 'verified', hours: 5 }), {
    verification: verification({
      after: 'merge',
      status: 'done',
      scan: { kind: 'repo', scanRunId: null, at: ago(4.8) },
      targeted: [137],
      cleared: [137],
    }),
  }),
  detail(
    run({
      id: 53,
      repo: R.ledger,
      kind: 'majors',
      state: 'failed',
      hours: 6,
      reached: 3,
      reason: 'The agent timed out: the runner stopped it after 40 minutes',
      agent: agentReport({
        outcome: 'timeout',
        detail: 'The runner stopped the agent after 40 minutes',
        summary: null,
        durationMs: 40 * 60_000,
        turns: 80,
        costUsd: 9.87,
      }),
    }),
  ),
  detail(run({ id: 48, repo: R.reports, state: 'dispatched', hours: 0.05 }), {
    tracking: { ...polled(1, 4), pausedUntil: ago(-0.07) },
  }),
  detail(run({ id: 47, repo: R.webhooks, state: 'pr_open', hours: 0.3 }), {
    tracking: polled(1, 1),
  }),
  detail(run({ id: 46, repo: R.cli, state: 'branch_pushed', hours: 0.12 }), {
    tracking: polled(0.2, 0.5),
  }),
  detail(run({ id: 45, repo: R.search, state: 'queued', hours: 0.08 }), {
    tracking: polled(0.3, 0.3, 'GitHub answered 502 while reading the workflow run'),
  }),
  detail(run({ id: 44, repo: R.auth, state: 'running', hours: 0.06 }), {
    tracking: polled(0.1, 0.3),
  }),
  detail(run({ id: 43, repo: R.billing, state: 'checks_passing', hours: 3 }), {
    tracking: polled(4, 6),
  }),
  detail(run({ id: 42, repo: R.paymentsSdk, state: 'checks_pending', hours: 0.4 }), {
    tracking: polled(1, 1),
  }),
  detail(run({ id: 41, repo: R.storefront, state: 'checks_failing', hours: 2, checks: FAILING }), {
    tracking: polled(3, 7),
  }),
  detail(run({ id: 52, repo: R.gateway, state: 'verified', hours: 30 }), {
    verification: verification({
      after: 'merge',
      status: 'done',
      scan: { kind: 'repo', scanRunId: null, at: ago(28) },
      targeted: [133],
      cleared: [133],
    }),
  }),
  detail(run({ id: 40, repo: R.ingest, state: 'deployed', hours: 26 }), {
    deployments: [appLink(R.ingest, { status: 'deployed', deploy: shipped(42, 'identical', 20) })],
    verification: verification({
      after: 'deploy',
      status: 'retrying',
      targeted: [114, 115],
      attempts: 2,
      lastError: 'The OSV source timed out while reading the repo',
      nextAttemptAt: ago(-0.2),
    }),
  }),
  // Merged a moment ago in a repo no app deploys: the rescan follows at once.
  detail(run({ id: 66, repo: R.ledger, state: 'merged', hours: 0.1 })),
  detail(run({ id: 39, repo: R.status, state: 'merged', hours: 80 }), {
    deployments: [appLink(R.status, { status: 'waiting', checkedAt: ago(8) })],
    warnings: [
      {
        code: 'watch_paths_skip',
        deploymentId: 7,
        message:
          'The watch paths src/** and public/** match none of the changed files (package.json, pnpm-lock.yaml), so Coolify may not deploy this merge on its own.',
        at: ago(79.8),
      },
      {
        code: 'deploy_not_seen',
        deploymentId: null,
        message:
          'No deploy of the merge commit showed up within 3 days. Hinomi stopped waiting; redeploy by hand and the next scan checks the findings.',
        at: ago(8),
      },
    ],
  }),
  detail(
    run({
      id: 38,
      repo: R.admin,
      state: 'closed_unmerged',
      hours: 30,
      reason: 'Closed on GitHub without merging',
    }),
    { tracking: polled(12, 18) },
  ),
  detail(run({ id: 37, repo: R.mailer, state: 'checks_none', hours: 5 }), {
    tracking: polled(5, 5),
  }),
  detail(
    run({
      id: 35,
      repo: R.billing,
      state: 'failed',
      hours: 50,
      reason:
        'GitHub answered 404: .github/workflows/hinomi-fix.yml is not on the default branch. Add the caller workflow, then run the plan again',
    }),
  ),
  detail(run({ id: 31, repo: R.storefront, state: 'superseded', hours: 52 })),
  detail(
    run({
      id: 25,
      repo: R.search,
      state: 'lost',
      hours: 80,
      reason: 'The workflow run was still going 40 minutes after it started',
    }),
  ),
  detail(
    run({
      id: 22,
      repo: R.admin,
      state: 'cancelled',
      hours: 96,
      reason: 'Cancelled on GitHub',
    }),
  ),
  detail(run({ id: 20, repo: R.auth, state: 'nothing_to_do', hours: 120 }), {
    verification: verification({
      after: 'empty_diff',
      status: 'scheduled_scan',
      targeted: [3],
      attempts: 5,
      lastError: 'The GitHub source answered 502 while reading the lockfile',
    }),
  }),
  detail(
    run({
      id: 18,
      repo: R.search,
      state: 'not_cleared',
      hours: 150,
      reason: 'The rescan still finds 1 of 2 findings',
    }),
    {
      deployments: [
        appLink(R.search, {
          status: 'deployed',
          deploy: shipped(18, 'identical', 145),
          checkedAt: ago(145),
        }),
      ],
      verification: verification({
        after: 'deploy',
        status: 'done',
        scan: { kind: 'repo', scanRunId: null, at: ago(140) },
        targeted: [4, 122],
        cleared: [122],
        stillOpen: [4],
      }),
    },
  ),
  detail(run({ id: 15, repo: R.auth, state: 'verified', hours: 170 }), {
    deployments: [appLink(R.auth, { status: 'other_branch', checkedAt: ago(169) })],
    verification: verification({
      after: 'merge',
      status: 'done',
      scan: { kind: 'repo', scanRunId: null, at: ago(169) },
      targeted: [123],
      cleared: [123],
    }),
  }),
  detail(run({ id: 12, repo: R.storefront, state: 'verified', hours: 200 }), {
    deployments: [
      appLink(R.storefront, {
        status: 'deployed',
        deploy: shipped(12, 'ahead', 196),
        checkedAt: ago(196),
      }),
    ],
    verification: verification({
      after: 'deploy',
      status: 'done',
      scan: { kind: 'full', scanRunId: 180, at: ago(190) },
      targeted: [101, 102, 103],
      cleared: [101, 102, 103],
      new: [14],
      attempts: 1,
    }),
  }),
]

export const runsFor = (repoId: number) => RUNS.filter((r) => r.repoId === repoId)

export const runFor = (id: number) => RUNS.find((r) => r.id === id)

// ---------------------------------------------------------------------------
// Runner status per repo

const permission = (
  name: string,
  label: string,
  purpose: string,
  status: RunnerPermission['status'] = 'granted',
  required = true,
): RunnerPermission => ({ name, label, purpose, required, status })

const PERMISSIONS: RunnerPermission[] = [
  permission('actions', 'Actions: write', 'Dispatch the caller workflow and read its runs'),
  permission('pull_requests', 'Pull requests: write', 'Open and update the fix pull request'),
  permission('contents', 'Contents: read', 'Read the caller workflow and the pushed branch'),
  permission('checks', 'Checks: read', 'Follow the checks on the pull request', 'granted', false),
  permission(
    'workflows',
    'Workflows: write',
    'Open the setup pull request with the caller workflow',
    'missing',
    false,
  ),
]

const CALLER_MESSAGE: Record<RunnerStatus['caller']['state'], string> = {
  missing: '.github/workflows/hinomi-fix.yml is not on the default branch yet.',
  invalid: 'The file is not valid YAML.',
  not_hinomi: 'The file does not call the Hinomi reusable workflow.',
  unpinned: 'Calls Hinomi by a tag, which can move. Pin a commit SHA.',
  pinned: 'Pinned by commit SHA.',
  current: 'Pinned to the latest Hinomi release.',
  outdated: 'Pinned to an older Hinomi release. It still works; update when convenient.',
  unknown: 'Could not read the caller workflow.',
}

/** What the host offers beyond GitHub Actions, the same for every repo. */
export interface RunnerHost {
  /** The webhook runner has a URL and a secret. */
  webhook: boolean
  /** HINOMI_LOCAL_RUNNER=1 is set and the host can run it. */
  local: boolean
}

export const DEFAULT_RUNNER_HOST: RunnerHost = { webhook: true, local: true }

function kindsOf(host: RunnerHost): NonNullable<RunnerStatus['runners']> {
  return {
    webhook: {
      configured: host.webhook,
      message: host.webhook
        ? 'Ready to dispatch to the webhook runner.'
        : 'Set the webhook runner URL and generate its secret first.',
    },
    local: {
      available: host.local,
      message: host.local
        ? 'Plans run on this host with the bundled fix runner action.'
        : 'The local runner is off. Set HINOMI_LOCAL_RUNNER=1 and restart Hinomi.',
      warning: LOCAL_RUNNER_WARNING,
    },
  }
}

function runner(
  repo: RepoRef,
  over: Partial<RunnerStatus> = {},
  host: RunnerHost = DEFAULT_RUNNER_HOST,
): RunnerStatus {
  const visibility = repo.id === R.storefront.id || repo.id === R.cli.id ? 'public' : 'private'
  const runs = runsFor(repo.id)
  return {
    repoId: repo.id,
    settings: {
      enabled: true,
      workflow: 'hinomi-fix.yml',
      majorsAgent: 'off',
      kind: 'github_actions',
    },
    defaultWorkflow: 'hinomi-fix.yml',
    ready: true,
    github: {
      fullName: repo.fullName,
      defaultBranch: 'main',
      visibility,
      checksMode: visibility === 'public' ? 'full' : 'install',
    },
    permissions: {
      auth: 'github_app',
      ok: true,
      canOpenSetupPr: false,
      items: PERMISSIONS,
      message: 'Every required permission is granted.',
    },
    setupPr: {
      available: false,
      reason: 'The caller already pins the latest Hinomi release.',
    },
    caller: {
      state: 'current',
      path: '.github/workflows/hinomi-fix.yml',
      ref: LATEST_SHA,
      present: true,
      pinnedSha: LATEST_SHA,
      outdated: false,
      latestSha: LATEST_SHA,
      missingInputs: [],
      passesAgentSecret: false,
      message: CALLER_MESSAGE.current,
      template: renderCallerWorkflow({ sha: LATEST_SHA, version: 'v0.2.0' }),
    },
    latestRun: runs[0] ?? null,
    closedUnmerged: null,
    checkedAt: ago(0.1),
    message: 'Ready to dispatch.',
    runners: kindsOf(host),
    ...over,
  }
}

/** A runner with the majors agent on, the caller passing the secret or not. */
function withAgent(repo: RepoRef, passesSecret: boolean): RunnerStatus {
  const base = runner(repo)
  return runner(repo, {
    settings: { ...base.settings, majorsAgent: 'claude-code' },
    caller: {
      ...base.caller,
      passesAgentSecret: passesSecret,
      template: renderCallerWorkflow({
        sha: LATEST_SHA,
        version: 'v0.2.0',
        majorsAgent: 'claude-code',
      }),
    },
    ...(passesSecret
      ? {}
      : {
          message:
            'Ready to dispatch. The majors agent is on but the caller workflow passes no ANTHROPIC_API_KEY, so it cannot run.',
        }),
  })
}

function callerOf(
  repo: RepoRef,
  state: RunnerStatus['caller']['state'],
  ref: string | null,
): RunnerStatus['caller'] {
  return {
    ...runner(repo).caller,
    state,
    ref,
    present: state !== 'missing',
    pinnedSha: ref && /^[0-9a-f]{40}$/.test(ref) ? ref : null,
    outdated: state === 'outdated',
    message: CALLER_MESSAGE[state],
  }
}

/** The status of a repo on the webhook or local runner: ready only when the host offers it. */
function onKind(repo: RepoRef, kind: 'webhook' | 'local', over: Partial<RunnerStatus['settings']>) {
  const base = runner(repo)
  return runner(repo, { settings: { ...base.settings, kind, ...over } })
}

function runnerBase(repoId: number): RunnerStatus | null {
  const p = planFor(repoId)
  if (!p) return null
  const repo = p.repo
  switch (repoId) {
    case R.docs.id:
      return runner(repo, {
        settings: { enabled: false, workflow: 'hinomi-fix.yml' },
        ready: false,
        caller: callerOf(repo, 'missing', null),
        setupPr: {
          available: false,
          reason:
            'The GitHub App cannot write workflow files. Grant it Workflows write, or paste the file by hand.',
        },
        message: 'Turn the runner on, then add the caller workflow to the default branch.',
      })
    case R.storefront.id:
      return runner(repo, {
        caller: callerOf(repo, 'outdated', OLD_SHA),
        setupPr: { available: true, reason: 'The GitHub App can write workflow files.' },
      })
    case R.cli.id:
      return runner(repo, {
        caller: callerOf(repo, 'unpinned', 'v0.1.0'),
        setupPr: {
          available: true,
          reason:
            "A fine grained token's Workflows write shows only when it is used, so the PR may be refused.",
        },
        permissions: {
          auth: 'fine_grained_token',
          ok: true,
          canOpenSetupPr: true,
          items: PERMISSIONS.map((p) =>
            p.name === 'workflows' ? { ...p, status: 'unverified' } : p,
          ),
          message: 'Write access of a fine grained token shows only when it is used.',
        },
      })
    case R.admin.id: {
      const closed = runFor(38)!
      return runner(repo, {
        closedUnmerged: {
          runId: closed.id,
          pr: { number: closed.pr!.number, url: closed.pr!.url },
          closedAt: closed.at.closed,
        },
      })
    }
    case R.courier.id:
      return onKind(repo, 'webhook', {})
    case R.beacon.id:
      return onKind(repo, 'webhook', { enabled: false })
    case R.forge.id:
      return onKind(repo, 'local', {})
    case R.vault.id:
      return onKind(repo, 'local', { majorsAgent: 'claude-code' })
    case R.scheduler.id:
      return withAgent(repo, false)
    case R.exporter.id:
    case R.gateway.id:
    case R.ledger.id:
      return withAgent(repo, true)
    default:
      return runner(repo)
  }
}

/**
 * The runner status of a repo as the host shapes it: the runners the host offers, and for a repo
 * on the webhook or local kind whether it can dispatch right now.
 */
export function runnerFor(
  repoId: number,
  host: RunnerHost = DEFAULT_RUNNER_HOST,
): RunnerStatus | null {
  const status = runnerBase(repoId)
  if (!status) return null
  const runners = kindsOf(host)
  const kind = status.settings.kind
  if ((kind !== 'webhook' && kind !== 'local') || !status.settings.enabled) {
    const off = kind === 'webhook' || kind === 'local'
    return {
      ...status,
      runners,
      ...(off && { ready: false, message: 'Turn the runner on to dispatch.' }),
    }
  }
  const offered = kind === 'webhook' ? host.webhook : host.local
  return {
    ...status,
    runners,
    ready: offered,
    message: offered
      ? `Ready to dispatch to the ${kind === 'webhook' ? 'webhook' : 'local'} runner.`
      : runners[kind]!.message,
  }
}
