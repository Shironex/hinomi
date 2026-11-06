import {
  deferFindingRequestSchema,
  FINDING_STATES,
  FINDING_TIERS,
  findingDetailSchema,
  findingsQuerySchema,
  findingsResponseSchema,
  idParamSchema,
  reopenFindingRequestSchema,
  type FindingGroup,
  type FindingState,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { z } from 'zod'
import {
  acceptFinding,
  canUserTransition,
  FindingTransitionError,
  listRankedFindings,
  reopenFinding,
  snoozeFinding,
  type RankedFinding,
} from '../../scan/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, readQuery, send } from '../http.js'
import { tierOf, toFindingDetail, toFindingListItem } from '../serialize.js'

type FindingsFilter = z.output<typeof findingsQuerySchema>

function haystack(ranked: RankedFinding): string {
  const { advisory, repo, finding } = ranked
  return [
    advisory?.packageName,
    advisory?.advisoryKey,
    advisory?.ghsaId,
    ...(advisory?.cveIds ?? []),
    ...(advisory?.aliases ?? []),
    advisory?.summary,
    repo ? `${repo.owner}/${repo.name}` : null,
    finding.blindSpotType?.replaceAll('_', ' '),
    finding.installedVersion,
    ...ranked.deployments.map((d) => d.name),
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n')
    .toLowerCase()
}

function hasAny<T>(wanted: readonly T[] | undefined, value: T): boolean {
  return wanted === undefined || wanted.length === 0 || wanted.includes(value)
}

export function filterFindings(items: RankedFinding[], filter: FindingsFilter): RankedFinding[] {
  const states: readonly FindingState[] | undefined = filter.state?.length
    ? filter.state
    : FINDING_STATES.filter((state) => state !== 'fixed')
  const q = filter.q?.toLowerCase()
  return items.filter(
    (r) =>
      hasAny(states, r.state) &&
      hasAny(filter.kind, r.kind) &&
      hasAny(filter.tier, tierOf(r)) &&
      hasAny(filter.severity, r.factors.severity) &&
      hasAny(filter.scope, r.finding.scope) &&
      (!filter.source?.length || r.finding.reportedBy.some((s) => filter.source!.includes(s))) &&
      (!filter.repo?.length || (r.repo !== null && filter.repo.includes(r.repo.id))) &&
      (!filter.deployment?.length ||
        r.deployments.some((d) => filter.deployment!.includes(d.id))) &&
      (!q || haystack(r).includes(q)),
  )
}

interface Group {
  key: string
  label: string
  items: RankedFinding[]
}

const TIER_LABEL: Record<(typeof FINDING_TIERS)[number], string> = {
  blind_spot: 'Blind spots',
  exposed: 'Exposed on a public app',
  internal: 'Deployed, internal only',
  public_low: 'Deployed and public, moderate or low',
  dev: 'Deployed, dev dependencies only',
  not_deployed: 'Not deployed',
}

function groupKey(r: RankedFinding, group: Exclude<FindingGroup, 'none'>): [string, string] {
  if (group === 'tier') {
    const tier = tierOf(r)
    return [tier, TIER_LABEL[tier]]
  }
  if (group === 'repo') {
    if (r.repo) return [`repo:${r.repo.id}`, `${r.repo.owner}/${r.repo.name}`]
    const deployment = r.deployments[0]
    return deployment
      ? [`deployment:${deployment.id}`, deployment.name]
      : ['none', 'No repo or deployment']
  }
  if (r.advisory) {
    return [
      `advisory:${r.advisory.advisoryKey}:${r.advisory.ecosystem}:${r.advisory.packageName}`,
      `${r.advisory.packageName} ${r.advisory.advisoryKey}`,
    ]
  }
  const type = r.finding.blindSpotType ?? 'blind_spot'
  return [`blind:${type}`, type.replaceAll('_', ' ')]
}

/** Groups in display order: tiers in their fixed order, others by their most urgent row. */
export function groupFindings(
  items: RankedFinding[],
  group: Exclude<FindingGroup, 'none'>,
): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const [key, label] = groupKey(item, group)
    let entry = groups.get(key)
    if (!entry) {
      entry = { key, label, items: [] }
      groups.set(key, entry)
    }
    entry.items.push(item)
  }
  const list = [...groups.values()]
  if (group === 'tier') {
    list.sort(
      (a, b) =>
        FINDING_TIERS.indexOf(a.key as (typeof FINDING_TIERS)[number]) -
        FINDING_TIERS.indexOf(b.key as (typeof FINDING_TIERS)[number]),
    )
  }
  return list
}

function findRanked(deps: ApiDeps, id: number): RankedFinding {
  const ranked = listRankedFindings(deps.repositories).find((r) => r.finding.id === id)
  if (!ranked) throw notFound('Finding')
  return ranked
}

function detail(deps: ApiDeps, id: number) {
  return toFindingDetail(findRanked(deps, id), deps.repositories.findings.listEvents(id))
}

/** Existence and state checks first, so the status code says what went wrong. */
function guardTransition(deps: ApiDeps, id: number, to: FindingState): void {
  const finding = deps.repositories.findings.get(id)
  if (!finding) throw notFound('Finding')
  if (!canUserTransition(finding.state, to)) {
    throw new HttpError(409, 'conflict', `A ${finding.state} finding cannot be moved to ${to}`)
  }
}

function transition(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    if (error instanceof FindingTransitionError) {
      throw new HttpError(400, 'bad_request', error.message)
    }
    throw error
  }
}

export function findingsRoutes(deps: ApiDeps) {
  const app = new Hono()

  app.get('/', (c) => {
    const query = readQuery(c, findingsQuerySchema)
    const matching = filterFindings(listRankedFindings(deps.repositories), query)
    const groups = query.group === 'none' ? [] : groupFindings(matching, query.group)
    const ordered = query.group === 'none' ? matching : groups.flatMap((g) => g.items)
    const page = ordered.slice(query.offset, query.offset + query.limit)
    const end = query.offset + page.length
    return send(c, findingsResponseSchema, {
      items: page.map(toFindingListItem),
      total: ordered.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: end < ordered.length ? end : null,
      group: query.group,
      groups: groups.map((g) => ({ key: g.key, label: g.label, count: g.items.length })),
    })
  })

  app.get('/:id', (c) => {
    const { id } = readParams(c, idParamSchema)
    return send(c, findingDetailSchema, detail(deps, id))
  })

  app.post('/:id/snooze', async (c) => {
    const { id } = readParams(c, idParamSchema)
    guardTransition(deps, id, 'snoozed')
    const body = await readJson(c, deferFindingRequestSchema)
    transition(() =>
      snoozeFinding(deps.repositories.findings, id, {
        reason: body.reason,
        until: new Date(body.until),
        now: deps.now(),
      }),
    )
    return send(c, findingDetailSchema, detail(deps, id))
  })

  app.post('/:id/accept', async (c) => {
    const { id } = readParams(c, idParamSchema)
    guardTransition(deps, id, 'accepted')
    const body = await readJson(c, deferFindingRequestSchema)
    transition(() =>
      acceptFinding(deps.repositories.findings, id, {
        reason: body.reason,
        until: new Date(body.until),
        now: deps.now(),
      }),
    )
    return send(c, findingDetailSchema, detail(deps, id))
  })

  app.post('/:id/reopen', async (c) => {
    const { id } = readParams(c, idParamSchema)
    guardTransition(deps, id, 'open')
    const body = await readJson(c, reopenFindingRequestSchema)
    transition(() =>
      reopenFinding(deps.repositories.findings, id, {
        reason: body.reason || null,
        now: deps.now(),
      }),
    )
    return send(c, findingDetailSchema, detail(deps, id))
  })

  return app
}
