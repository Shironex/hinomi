import type { FindingGroup, FindingListItem, FindingsResponse, FindingTier } from '@hinomi/shared'
import { DEFAULT_FIX_RUN_NOTIFY_EVENTS, FINDING_TIERS, releaseTierModeSchema } from '@hinomi/shared'
import {
  ACCESS,
  CHANNELS,
  DEPLOYMENTS,
  FINDINGS,
  FIXES,
  LAST_SCAN,
  OVERVIEW,
  REPOS,
  SOURCES,
  deploymentDetailFor,
  deploysFor,
  detailFor,
} from './dataset'
import { WEBHOOK_SECRET, isWebhookScenario, webhookFor, type WebhookScenario } from './webhook'
import { guardNavCount, guardsResponseOf, overridesOf } from './guards'
import { PLAN_REFS, planFor, planRefFor, runFor, runnerFor, runsFor } from './fix-runs'
import { FIXTURE_VERSION, versionFor } from './version'
import { repoDetailFor, setReleaseTier } from './repo-sources'
import {
  RUNNER_SECRET,
  isRunnerScenario,
  runnerHostFor,
  webhookRunnerFor,
  type RunnerScenario,
} from './webhook-runner'

/**
 * `default`: a configured instance after a scan. `setup`: first run with Coolify connected
 * and GitHub not yet, so setup opens on its second step. `update` is the default instance with
 * a newer release available (see ./version). The `webhook-*` scenarios are the
 * default instance with the GitHub webhook in one state (see ./webhook). The `runner-*` and
 * `local-off` scenarios are the default instance with the webhook runner in one state, or a
 * host without the local runner (see ./webhook-runner).
 */
export type FixtureScenario = 'default' | 'setup' | 'update' | WebhookScenario | RunnerScenario

export const isFixtureScenario = (value: string | null): value is FixtureScenario =>
  value === 'default' ||
  value === 'setup' ||
  value === 'update' ||
  isWebhookScenario(value) ||
  isRunnerScenario(value)

export interface FixtureReply {
  status: number
  body?: unknown
}

const ok = (body: unknown): FixtureReply => ({ status: 200, body })
const notFound = (path: string): FixtureReply => ({
  status: 404,
  body: { error: { code: 'not_found', message: `Fixture mode has nothing at ${path}` } },
})

const TIER_LABELS: Record<FindingTier, string> = {
  blind_spot: 'Blind spots',
  exposed: 'Exposed on a public app',
  internal: 'Deployed, internal only',
  released: 'Released desktop apps',
  public_low: 'Public, moderate or low',
  dev: 'Development only',
  not_deployed: 'Not deployed',
  patched: 'Patched in the lockfile',
  coverage: 'Coverage notes',
}

const list = (params: URLSearchParams, key: string) =>
  params.get(key)?.split(',').filter(Boolean) ?? null

/** GET /findings over the fixed dataset, with the filters the views send. */
export function filterFindings(params: URLSearchParams): FindingsResponse {
  let rows: FindingListItem[] = FINDINGS
  const tier = list(params, 'tier')
  const state = list(params, 'state')
  const severity = list(params, 'severity')
  const source = list(params, 'source')
  const scope = list(params, 'scope')
  const kind = list(params, 'kind')
  const check = list(params, 'check')
  const level = list(params, 'level')
  const release = params.get('release')
  const repo = list(params, 'repo')?.map(Number)
  const deployment = list(params, 'deployment')?.map(Number)
  const q = params.get('q')?.trim().toLowerCase()

  if (tier) rows = rows.filter((f) => tier.includes(f.tier))
  rows = state
    ? rows.filter((f) => state.includes(f.state))
    : rows.filter((f) => f.state !== 'fixed')
  if (severity) rows = rows.filter((f) => severity.includes(f.factors.severity))
  if (source) rows = rows.filter((f) => f.sources.some((s) => source.includes(s)))
  if (scope) rows = rows.filter((f) => scope.includes(f.scope))
  if (kind) rows = rows.filter((f) => kind.includes(f.kind))
  if (check) rows = rows.filter((f) => f.guard !== null && check.includes(f.guard.check))
  if (level) rows = rows.filter((f) => f.guard !== null && level.includes(f.guard.level))
  if (release === 'true') rows = rows.filter((f) => f.releaseTag !== null)
  if (release === 'false') rows = rows.filter((f) => f.releaseTag === null)
  if (repo) rows = rows.filter((f) => f.repo !== null && repo.includes(f.repo.id))
  if (deployment) {
    rows = rows.filter((f) => f.deployments.some((d) => deployment.includes(d.id)))
  }
  if (q) {
    rows = rows.filter((f) =>
      [f.advisory?.packageName, f.advisory?.advisoryKey, f.repo?.fullName, f.guard?.title]
        .filter(Boolean)
        .some((text) => text!.toLowerCase().includes(q)),
    )
  }

  const group = (params.get('group') ?? 'none') as FindingGroup
  let groups: FindingsResponse['groups'] = []
  if (group === 'tier') {
    rows = [...rows].sort((a, b) => FINDING_TIERS.indexOf(a.tier) - FINDING_TIERS.indexOf(b.tier))
    groups = FINDING_TIERS.flatMap((t) => {
      const n = rows.filter((r) => r.tier === t).length
      return n ? [{ key: t, label: TIER_LABELS[t], count: n }] : []
    })
  }

  const limit = Number(params.get('limit') ?? 50)
  const offset = Number(params.get('offset') ?? 0)
  const page = rows.slice(offset, offset + limit)
  return {
    items: page,
    total: rows.length,
    offset,
    limit,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    group,
    groups,
  }
}

function idFrom(path: string, pattern: RegExp): number | null {
  const match = pattern.exec(path)
  return match ? Number(match[1]) : null
}

const readOnly: FixtureReply = {
  status: 403,
  body: { error: { code: 'forbidden', message: 'Fixture mode is read only' } },
}

/**
 * POST /repos/:id/fix-runs. Nothing is dispatched; a repo whose last fix PR was closed unmerged
 * answers the 409 that asks before a fresh PR, so the confirmation can be seen.
 */
function dispatchReply(repoId: number, body: unknown): FixtureReply {
  const previous = runnerFor(repoId)?.closedUnmerged
  const confirmed =
    typeof body === 'object' && body !== null && 'confirmReopen' in body && body.confirmReopen
  if (previous && !confirmed) {
    return {
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: `The last fix PR #${previous.pr.number} was closed without merging. Send confirmReopen: true to open a fresh one.`,
        },
        previous,
      },
    }
  }
  return readOnly
}

/** The fixed fixes and finding details with the plan links of the fix runs fixtures. */
const withPlans = <T extends { repo: { id: number } | null; plan: unknown }>(item: T): T => ({
  ...item,
  plan: item.repo ? planRefFor(item.repo.id) : null,
})

/**
 * Answers one API request from the fixed dataset. Reads are served; fixture mode exists for
 * screenshots and demos, so writes are refused with a clear message, except the few it keeps.
 */
export function fixtureRoute(
  method: string,
  url: URL,
  scenario: FixtureScenario = 'default',
  body?: unknown,
): FixtureReply {
  const path = url.pathname.replace(/^\/api/, '')
  const setup = scenario === 'setup'

  if (method === 'POST' && path === '/settings/github-webhook/secret') {
    // The one write fixture mode serves, so the "shown once" state can be captured.
    return ok({ secret: WEBHOOK_SECRET, settings: webhookFor(scenario) })
  }

  if (method === 'POST' && path === '/settings/webhook-runner/secret') {
    return { status: 201, body: { secret: RUNNER_SECRET, settings: webhookRunnerFor(scenario) } }
  }

  if (method === 'PUT') {
    // The release tier mode is the one repo write fixture mode keeps (in memory), so the panel's
    // control can be tried. Anything else is refused.
    const tierRepo = idFrom(path, /^\/repos\/(\d+)\/release-tier$/)
    const mode = releaseTierModeSchema.safeParse((body as { tier?: unknown } | undefined)?.tier)
    if (tierRepo !== null && mode.success) {
      const repo = setReleaseTier(tierRepo, mode.data)
      return repo ? ok(repo) : notFound(path)
    }
  }

  if (method !== 'GET') {
    const dispatchId = method === 'POST' ? idFrom(path, /^\/repos\/(\d+)\/fix-runs$/) : null
    return dispatchId === null ? readOnly : dispatchReply(dispatchId, body)
  }

  switch (path) {
    case '/health':
      return ok({ status: 'ok', version: FIXTURE_VERSION })
    case '/version':
      return ok(versionFor(scenario === 'update'))
    case '/access':
      return ok(ACCESS)
    case '/onboarding':
      return ok({ finished: !setup, alertsSkipped: false })
    case '/shell/nav-counts':
      return ok(
        setup
          ? {
              needsAction: null,
              deployments: null,
              alerts: null,
              activeFixRuns: null,
              guards: null,
            }
          : {
              needsAction: OVERVIEW.funnel.needsAction,
              deployments: DEPLOYMENTS.length,
              alerts: OVERVIEW.funnel.total,
              activeFixRuns: null,
              guards: guardNavCount(FINDINGS),
            },
      )
    case '/shell/scan-status':
      return ok(
        setup
          ? { state: 'queued', nextScanAt: null }
          : { state: 'idle', lastScanAt: LAST_SCAN.finishedAt, nextScanAt: OVERVIEW.nextScanAt },
      )
    case '/overview':
      return ok(OVERVIEW)
    case '/findings':
      return ok(filterFindings(url.searchParams))
    case '/fixes': {
      const limit = Number(url.searchParams.get('limit') ?? 25)
      return ok({
        items: FIXES.slice(0, limit).map((fix) => ({ ...fix, repos: fix.repos.map(withPlans) })),
        total: FIXES.length,
        offset: 0,
        limit,
        nextOffset: null,
      })
    }
    case '/deployments':
      return ok({ items: DEPLOYMENTS })
    case '/guards':
      return ok(guardsResponseOf(setup ? [] : FINDINGS))
    case '/overrides':
      return ok({ items: setup ? [] : overridesOf(FINDINGS) })
    case '/repos':
      return ok({ items: Object.values(REPOS) })
    case '/sources':
      return ok({ sources: setup ? SOURCES.slice(0, 1) : SOURCES, canStoreTokens: true })
    case '/settings':
      return ok({
        scanIntervalMinutes: 360,
        osvEnabled: true,
        includeAccountRepos: false,
        updateCheckEnabled: true,
        supportWindowDays: 180,
        imageScan: 'off',
        rustBehindReleases: 4,
        bunBehindReleases: 4,
      })
    case '/settings/github-webhook':
      return ok(webhookFor(scenario))
    case '/settings/webhook-runner':
      return ok(webhookRunnerFor(scenario))
    case '/scans':
      return ok({ items: setup ? [] : [LAST_SCAN] })
    case '/notifications/channels':
      return ok({ items: setup ? [] : CHANNELS })
    case '/plans':
      return ok({ items: setup ? [] : PLAN_REFS })
    case '/notifications/settings':
      return ok({
        publicBaseUrl: 'https://hinomi.example.dev',
        digestHour: 8,
        fixRunEvents: { ...DEFAULT_FIX_RUN_NOTIFY_EVENTS, verified: false },
      })
  }

  const findingId = idFrom(path, /^\/findings\/(\d+)$/)
  if (findingId !== null) {
    const item = FINDINGS.find((f) => f.id === findingId)
    return item ? ok(withPlans(detailFor(item))) : notFound(path)
  }

  const repoId = idFrom(path, /^\/repos\/(\d+)$/)
  if (repoId !== null) {
    const repo = repoDetailFor(repoId)
    return repo ? ok(repo) : notFound(path)
  }

  const planRepo = idFrom(path, /^\/repos\/(\d+)\/plan$/)
  if (planRepo !== null) {
    const plan = planFor(planRepo)
    return plan ? ok(plan) : notFound(path)
  }

  const runnerRepo = idFrom(path, /^\/repos\/(\d+)\/runner$/)
  if (runnerRepo !== null) {
    const status = runnerFor(runnerRepo, runnerHostFor(scenario))
    return status ? ok(status) : notFound(path)
  }

  const runsRepo = idFrom(path, /^\/repos\/(\d+)\/fix-runs$/)
  if (runsRepo !== null) {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    return ok({ items: runsFor(runsRepo).slice(0, limit) })
  }

  const runId = idFrom(path, /^\/fix-runs\/(\d+)$/)
  if (runId !== null) {
    const run = runFor(runId)
    return run ? ok(run) : notFound(path)
  }

  const scanId = idFrom(path, /^\/scans\/(\d+)$/)
  if (scanId !== null) return scanId === LAST_SCAN.id ? ok(LAST_SCAN) : notFound(path)

  const deploysId = idFrom(path, /^\/deployments\/(\d+)\/deploys$/)
  if (deploysId !== null) {
    const item = DEPLOYMENTS.find((d) => d.id === deploysId)
    if (!item) return notFound(path)
    const items = deploysFor(item)
    return ok({
      available: items.length > 0,
      reason: items.length ? null : 'Coolify lists deploys for applications only',
      items,
    })
  }

  const deploymentId = idFrom(path, /^\/deployments\/(\d+)$/)
  if (deploymentId !== null) {
    const item = DEPLOYMENTS.find((d) => d.id === deploymentId)
    return item ? ok(deploymentDetailFor(item)) : notFound(path)
  }

  return notFound(path)
}
