import {
  FINDING_TIERS,
  FIX_BRANCH,
  isFixRunTerminal,
  renderCallerWorkflow,
  type FindingTier,
  type FixCheckResult,
  type FixPlan,
  type FixPlanRef,
  type FixPlanStep,
  type FixPlanUnfixed,
  type FixResultV1,
  type FixRun,
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
}

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

function result(input: RunInput, at: (i: number) => string): FixResultV1 | null {
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
    runner: 'github_actions',
    kind: 'fix',
    correlationId: `fr-${input.id}`,
    branch: FIX_BRANCH,
    checksMode: input.repo.id === R.storefront.id ? 'full' : 'install',
    state,
    stateReason: input.reason ?? null,
    terminal,
    github: reached >= 1 ? { runId: 18_204_000 + input.id, runAttempt: 1 } : null,
    headSha: reached >= 4 && state !== 'nothing_to_do' ? hex(input.id + 1, 40) : null,
    pr: hasPr
      ? {
          number: prNumber,
          url: `https://github.com/${input.repo.fullName}/pull/${prNumber}`,
          draft: state === 'checks_failing',
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

const detail = (r: FixRun, extra: DetailExtra = {}): FixRunDetail => ({
  ...r,
  tracking: null,
  deployments: [],
  warnings: [],
  verification: null,
  ...extra,
})

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

function runner(repo: RepoRef, over: Partial<RunnerStatus> = {}): RunnerStatus {
  const visibility = repo.id === R.storefront.id || repo.id === R.cli.id ? 'public' : 'private'
  const runs = runsFor(repo.id)
  return {
    repoId: repo.id,
    settings: { enabled: true, workflow: 'hinomi-fix.yml' },
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
      message: CALLER_MESSAGE.current,
      template: renderCallerWorkflow({ sha: LATEST_SHA, version: 'v0.2.0' }),
    },
    latestRun: runs[0] ?? null,
    closedUnmerged: null,
    checkedAt: ago(0.1),
    message: 'Ready to dispatch.',
    ...over,
  }
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

export function runnerFor(repoId: number): RunnerStatus | null {
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
    default:
      return runner(repo)
  }
}
