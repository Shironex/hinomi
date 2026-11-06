import {
  FINDING_TIERS,
  FUNNEL_STEPS,
  idParamSchema,
  navCountsSchema,
  overviewResponseSchema,
  scanRunSchema,
  scansQuerySchema,
  scansResponseSchema,
  scanStatusSchema,
  settingsSchema,
  startScanResponseSchema,
  updateSettingsRequestSchema,
  type ActivityItem,
  type FindingTier,
  type FunnelReach,
  type FunnelStep,
  type ScanStatusDto,
  type SeverityCounts,
  type SettingsDto,
  type SourceHealth,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { Repositories, Source } from '../../repository/index.js'
import {
  countFindings,
  funnelSteps,
  listRankedFindings,
  readScanSettings,
  SCAN_SETTING_KEYS,
  type RankedFinding,
} from '../../scan/index.js'
import {
  isConfigured,
  readScanIntervalMinutes,
  SCAN_INTERVAL_KEY,
  SchedulerClosedError,
  type Scheduler,
  type StartScanResult,
} from '../../scheduler/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, readQuery, send } from '../http.js'
import { tierOf, toFindingEvent, toScanRun } from '../serialize.js'

const RECENT_ACTIVITY = 20

function readSettings(repositories: Repositories): SettingsDto {
  return {
    scanIntervalMinutes: readScanIntervalMinutes(repositories.settings),
    ...readScanSettings(repositories.settings),
  }
}

function sourceHealth(source: Source): SourceHealth {
  const status: SourceHealth['status'] = !source.enabled
    ? 'disabled'
    : source.kind !== 'osv' && !source.hasToken
      ? 'missing_token'
      : source.lastError !== null
        ? 'error'
        : source.lastOkAt
          ? 'ok'
          : 'never'
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    status,
    lastOkAt: source.lastOkAt?.toISOString() ?? null,
    lastErrorAt: source.lastErrorAt?.toISOString() ?? null,
    lastError: source.lastError,
  }
}

function findingTitle(r: RankedFinding): string {
  if (r.advisory) return `${r.advisory.packageName} ${r.advisory.advisoryKey}`
  if (r.kind === 'coverage_note') return 'image only'
  return (r.finding.blindSpotType ?? 'blind spot').replaceAll('_', ' ')
}

function recentActivity(repositories: Repositories, ranked: RankedFinding[]): ActivityItem[] {
  const byId = new Map(ranked.map((r) => [r.finding.id, r]))
  return repositories.findings.listRecentEvents(RECENT_ACTIVITY).flatMap((event) => {
    const r = byId.get(event.findingId)
    if (!r) return []
    return [
      {
        ...toFindingEvent(event),
        finding: {
          id: r.finding.id,
          kind: r.kind,
          title: findingTitle(r),
          severity: r.factors.severity,
          repo: r.repo ? `${r.repo.owner}/${r.repo.name}` : (r.deployments[0]?.name ?? null),
        },
      },
    ]
  })
}

function tierCounts(ranked: RankedFinding[]): Record<FindingTier, number> {
  const counts = Object.fromEntries(FINDING_TIERS.map((t) => [t, 0])) as Record<FindingTier, number>
  for (const r of ranked) if (r.state !== 'fixed') counts[tierOf(r)]++
  return counts
}

function tierSeverity(ranked: RankedFinding[]): Record<FindingTier, SeverityCounts> {
  const counts = Object.fromEntries(
    FINDING_TIERS.map((t) => [t, { critical: 0, high: 0, moderate: 0, low: 0 }]),
  ) as Record<FindingTier, SeverityCounts>
  for (const r of ranked) if (r.state !== 'fixed') counts[tierOf(r)][r.factors.severity]++
  return counts
}

/** Distinct repos and deployments behind each funnel step. */
export function funnelReach(ranked: RankedFinding[]): Record<FunnelStep, FunnelReach> {
  const sets = Object.fromEntries(
    FUNNEL_STEPS.map((step) => [step, { repos: new Set<number>(), apps: new Set<number>() }]),
  ) as Record<FunnelStep, { repos: Set<number>; apps: Set<number> }>
  for (const r of ranked) {
    for (const step of funnelSteps(r)) {
      if (r.repo) sets[step].repos.add(r.repo.id)
      for (const d of r.deployments) sets[step].apps.add(d.id)
    }
  }
  return Object.fromEntries(
    FUNNEL_STEPS.map((step) => [
      step,
      { repos: sets[step].repos.size, apps: sets[step].apps.size },
    ]),
  ) as Record<FunnelStep, FunnelReach>
}

/**
 * Shell scan status. While a scan runs it reports its phase and progress;
 * otherwise the latest finished run. Connected but never scanned is queued:
 * the scheduler starts the first scan as soon as a source is connected.
 */
export function scanStatus(repositories: Repositories, scheduler: Scheduler): ScanStatusDto {
  const progress = scheduler.progress()
  if (progress) {
    return {
      state: 'scanning',
      scanRunId: progress.scanRunId,
      startedAt: progress.startedAt.toISOString(),
      phase: progress.phase,
      done: progress.done,
      total: progress.total,
      skipped: progress.skipped,
    }
  }
  if (!isConfigured(repositories)) return { state: 'unconfigured' }
  const runs = repositories.scanRuns.list(20).filter((r) => r.status !== 'running')
  const latest = runs[0]
  if (!latest) {
    return { state: 'queued', nextScanAt: scheduler.nextScanAt()?.toISOString() ?? null }
  }
  const finishedAt = (latest.finishedAt ?? latest.startedAt).toISOString()
  if (latest.status === 'failed') {
    const lastGood = runs.find((r) => r.status !== 'failed')
    const firstSourceError = Object.values(latest.sourceResults).find((r) => r?.error)?.error
    return {
      state: 'failed',
      lastScanAt: lastGood ? (lastGood.finishedAt ?? lastGood.startedAt).toISOString() : null,
      message: latest.error ?? firstSourceError ?? 'The last scan failed',
    }
  }
  return {
    state: 'idle',
    lastScanAt: finishedAt,
    nextScanAt: scheduler.nextScanAt()?.toISOString() ?? null,
  }
}

export function overviewRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/', (c) => {
    const ranked = listRankedFindings(repositories)
    const counts = countFindings(ranked, deps.now())
    const lastScan = repositories.scanRuns.latest()
    return send(c, overviewResponseSchema, {
      funnel: counts.advisories,
      blindSpots: counts.blindSpots,
      funnelReach: funnelReach(ranked),
      tiers: tierCounts(ranked),
      tierSeverity: tierSeverity(ranked),
      lastScan: lastScan ? toScanRun(lastScan) : null,
      nextScanAt: scheduler.nextScanAt()?.toISOString() ?? null,
      sources: repositories.sources.list().map(sourceHealth),
      recentActivity: recentActivity(repositories, ranked),
    })
  })

  return app
}

export function settingsRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/', (c) => send(c, settingsSchema, readSettings(repositories)))

  app.patch('/', async (c) => {
    const body = await readJson(c, updateSettingsRequestSchema)
    repositories.db.transaction(() => {
      if (body.scanIntervalMinutes !== undefined) {
        repositories.settings.set(SCAN_INTERVAL_KEY, body.scanIntervalMinutes)
      }
      if (body.osvEnabled !== undefined) {
        repositories.settings.set(SCAN_SETTING_KEYS.osvEnabled, body.osvEnabled)
      }
      if (body.includeAccountRepos !== undefined) {
        repositories.settings.set(SCAN_SETTING_KEYS.includeAccountRepos, body.includeAccountRepos)
      }
    })
    if (body.scanIntervalMinutes !== undefined) scheduler.reschedule()
    return send(c, settingsSchema, readSettings(repositories))
  })

  return app
}

export function scansRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/', (c) => {
    const { limit } = readQuery(c, scansQuerySchema)
    return send(c, scansResponseSchema, {
      items: repositories.scanRuns.list(limit).map(toScanRun),
    })
  })

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    const run = repositories.scanRuns.get(id)
    if (!run) throw notFound('Scan run')
    return send(c, scanRunSchema, toScanRun(run))
  })

  /** Starts a scan now. When one is running, answers 200 with that scan instead. */
  app.post('/', (c) => {
    let result: StartScanResult
    try {
      result = scheduler.scanNow('manual')
    } catch (error) {
      if (error instanceof SchedulerClosedError)
        throw new HttpError(503, 'unavailable', error.message)
      throw error
    }
    return send(
      c,
      startScanResponseSchema,
      { started: result.started, run: toScanRun(result.run) },
      result.started ? 202 : 200,
    )
  })

  return app
}

export function shellRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories, scheduler } = deps

  app.get('/nav-counts', (c) => {
    const ranked = listRankedFindings(repositories)
    const counts = countFindings(ranked, deps.now())
    return send(c, navCountsSchema, {
      needsAction: counts.advisories.needsAction,
      deployments: repositories.deployments.list().length,
      alerts: counts.advisories.total + counts.blindSpots.total,
      activeFixRuns: null,
    })
  })

  app.get('/scan-status', (c) => send(c, scanStatusSchema, scanStatus(repositories, scheduler)))

  return app
}
