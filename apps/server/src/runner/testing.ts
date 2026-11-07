import {
  FINDING_TIERS,
  FIX_RESULT_SCHEMA,
  fixPlanSchema,
  parseFixResult,
  type FindingTier,
  type FixPlan,
  type FixResultV1,
} from '@hinomi/shared'
import type { FixPlanRow, RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'

// Test helpers for the runner: a fake GitHub API routed by method and path, and a fix plan with
// steps the dispatch keeps. Every org, repo and package here is fictional.

export const GITHUB_API = 'https://api.github.com'

export interface FakeRequest {
  method: string
  /** Path and query, without the API root. */
  path: string
  body: unknown
  authorization: string | null
}

export interface FakeReply {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

export interface FakeRoute {
  method?: string
  /** Exact path (query included) or a pattern. */
  path: string | RegExp
  reply: FakeReply | ((request: FakeRequest) => FakeReply)
}

/** A fetch that answers from routes and records every request. Unrouted requests answer 404. */
export function fakeGithub(routes: FakeRoute[]) {
  const requests: FakeRequest[] = []
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    const raw = init?.body
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null,
      authorization: new Headers(init?.headers).get('authorization'),
    }
    requests.push(request)
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === request.method &&
        (typeof r.path === 'string' ? r.path === request.path : r.path.test(request.path)),
    )
    const reply: FakeReply = route
      ? typeof route.reply === 'function'
        ? route.reply(request)
        : route.reply
      : { status: 404, body: { message: 'Not Found' } }
    const status = reply.status ?? 200
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body)
    return Promise.resolve(
      new Response(status === 204 ? null : text, { status, headers: reply.headers }),
    )
  }
  return { fetch: impl, requests }
}

/** GET /repos/{owner}/{name} as GitHub answers it. */
export function repoReply(
  owner: string,
  name: string,
  visibility: 'public' | 'private',
  defaultBranch = 'main',
): FakeReply {
  return {
    body: {
      name,
      owner: { login: owner },
      archived: false,
      default_branch: defaultBranch,
      visibility,
      private: visibility === 'private',
    },
  }
}

/** GET /repos/{o}/{r}/contents/{path} for a text file. */
export function fileReply(text: string): FakeReply {
  return {
    body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') },
  }
}

function tiers(partial: Partial<Record<FindingTier, number>>): Record<FindingTier, number> {
  return Object.fromEntries(FINDING_TIERS.map((t) => [t, partial[t] ?? 0])) as Record<
    FindingTier,
    number
  >
}

/** A plan for the repo with two safe pnpm steps and one risky major. */
export function runnerPlan(repo: RepoRow, scanRunId: number, at: Date): FixPlan {
  const base = {
    ecosystem: 'npm',
    relationship: 'direct' as const,
    lockfile: 'pnpm-lock.yaml',
    packageManager: 'pnpm' as const,
    workspaces: ['.'],
    via: [],
    riskReasons: [],
    note: null,
    releasedAt: null,
    releaseAge: 'unknown' as const,
  }
  const step = (
    id: string,
    order: number,
    packageName: string,
    from: string,
    to: string,
    risk: 'safe' | 'risky' = 'safe',
  ) => ({
    ...base,
    id,
    order,
    packageName,
    findingIds: [order],
    advisories: [`GHSA-${id}-aaaa-0001`],
    byTier: tiers({ exposed: 1 }),
    from: [from],
    to,
    level: risk === 'risky' ? ('major' as const) : ('minor' as const),
    risk,
    ...(risk === 'risky' && { riskReasons: ['semver_major' as const], note: 'Read the changelog' }),
    apply: {
      type: 'manifest_bump' as const,
      manifests: ['package.json'],
      packageName,
      version: to,
    },
  })
  return fixPlanSchema.parse({
    version: 1,
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: `${repo.owner}/${repo.name}`,
      archived: false,
      alertsEnabled: true,
      lastScannedAt: null,
    },
    scanRunId,
    createdAt: at.toISOString(),
    projects: [
      { lockfile: 'pnpm-lock.yaml', root: '.', packageManager: 'pnpm', workspaces: ['.'] },
    ],
    steps: [
      step('s1', 1, 'plover-parse', '1.2.0', '1.3.0'),
      step('s2', 2, 'heron-ui', '4.0.1', '4.0.3'),
      step('s3', 3, 'egret-db', '2.9.0', '3.0.0', 'risky'),
    ],
    unfixed: [],
    summary: {
      findings: {
        total: 3,
        cleared: 3,
        clearedSafely: 2,
        unfixed: 0,
        clearedByTier: tiers({ exposed: 3 }),
        unfixedByTier: tiers({}),
      },
      steps: { safe: 2, risky: 1 },
      unfixed: 0,
    },
    previous: null,
  })
}

/** Saves a runner plan for the repo from a new scan run. */
export function saveRunnerPlan(repos: Repositories, repo: RepoRow, at: Date): FixPlanRow {
  const scan = repos.scanRuns.start('manual', at)
  return repos.fixPlans.save(runnerPlan(repo, scan.id, at), at)
}

/** A GitHub token source the runner finds, with a fictional token. */
export function connectGithubToken(
  repos: Repositories,
  token = 'github_pat_fictional0000000000000000',
) {
  return repos.sources.create({ kind: 'github', name: 'kestrel-co', token })
}

/**
 * The runner's result for a runner plan: both safe steps applied, install and one check
 * passed. `checkFailed` makes the test check fail, so the PR is a draft.
 */
export function runnerResult(
  plan: FixPlan,
  runId: string,
  options: { repo?: string; checkFailed?: boolean } = {},
): FixResultV1 {
  const safe = plan.steps.filter((step) => step.risk === 'safe')
  return parseFixResult({
    schema: FIX_RESULT_SCHEMA,
    runId,
    planScanRunId: plan.scanRunId,
    repo: options.repo ?? plan.repo.fullName,
    baseSha: 'a'.repeat(40),
    packageManager: 'pnpm',
    packageManagerVersion: '10.20.0',
    checksMode: 'full',
    steps: safe.map((step) => ({
      id: step.id,
      status: 'applied',
      reason: null,
      detail: null,
      files: ['package.json'],
    })),
    releaseAge: [],
    install: { status: 'ok', durationMs: 20_000, output: null, truncated: false },
    checks: [
      {
        name: 'test',
        command: 'pnpm test',
        status: options.checkFailed ? 'failed' : 'passed',
        durationMs: 40_000,
        output: options.checkFailed ? 'FAIL harbor.test.ts' : null,
        truncated: false,
      },
    ],
    patch: { sha256: 'b'.repeat(64), files: ['package.json'], insertions: 2, deletions: 2 },
    finishedAt: '2026-11-07T10:05:00.000Z',
  })
}
