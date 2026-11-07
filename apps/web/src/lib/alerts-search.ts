import {
  type FindingListItem,
  type FindingsResponse,
  findingGroupSchema,
  findingKindSchema,
  findingScopeSchema,
  findingStateSchema,
  findingTierSchema,
  guardCheckSchema,
  guardLevelSchema,
  reporterSchema,
  severitySchema,
} from '@hinomi/shared'
import { z } from 'zod'
import type { FindingsParams } from './view-api'

/**
 * Search params of /alerts, so a filtered view is a link: the overview funnel and the
 * deployment pages point into it. Anything malformed falls back to no filter.
 */
const list = <T extends z.ZodType>(item: T) => z.array(item).optional().catch(undefined)
const ids = z.array(z.number().int().positive()).optional().catch(undefined)

export const alertsSearchSchema = z.object({
  tier: list(findingTierSchema),
  severity: list(severitySchema),
  scope: list(findingScopeSchema),
  source: list(reporterSchema),
  /** `all`: reported by every listed source ("both" with GitHub and OSV). */
  sourceMatch: z.enum(['any', 'all']).optional().catch(undefined),
  state: list(findingStateSchema),
  /** `guard` with the Guards chip; the check and level filters only match guard findings. */
  kind: list(findingKindSchema),
  check: list(guardCheckSchema),
  level: list(guardLevelSchema),
  repo: ids,
  deployment: ids,
  q: z.string().max(200).optional().catch(undefined),
  group: findingGroupSchema.optional().catch(undefined),
})

export type AlertsSearch = z.infer<typeof alertsSearchSchema>

export const DEFAULT_GROUP = 'tier'

/** Filters in the URL to the API's list query. */
export function alertsParams(search: AlertsSearch, limit: number): FindingsParams {
  return {
    tier: search.tier,
    severity: search.severity,
    scope: search.scope,
    source: search.source,
    sourceMatch: search.sourceMatch,
    state: search.state,
    kind: search.kind,
    check: search.check,
    level: search.level,
    repo: search.repo,
    deployment: search.deployment,
    q: search.q,
    group: search.group ?? DEFAULT_GROUP,
    limit,
  }
}

/** True when any filter narrows the list (grouping is not a filter). */
export function hasFilters(search: AlertsSearch): boolean {
  return Boolean(
    search.tier?.length ||
    search.severity?.length ||
    search.scope?.length ||
    search.source?.length ||
    search.state?.length ||
    search.kind?.length ||
    search.check?.length ||
    search.level?.length ||
    search.repo?.length ||
    search.deployment?.length ||
    search.q?.trim(),
  )
}

/** The source select's value: one source, both, or any. */
export function sourceValue(search: Pick<AlertsSearch, 'source' | 'sourceMatch'>): string {
  const sources = search.source ?? []
  if (sources.length === 0) return 'all'
  if (search.sourceMatch === 'all' && sources.length > 1) return 'both'
  return sources.length === 1 ? (sources[0] ?? 'all') : 'all'
}

/** The search params for a source select value. */
export function sourceFilter(value: string): Pick<AlertsSearch, 'source' | 'sourceMatch'> {
  if (value === 'both') return { source: ['github', 'osv'], sourceMatch: 'all' }
  if (value === 'github' || value === 'osv') return { source: [value], sourceMatch: undefined }
  return { source: undefined, sourceMatch: undefined }
}

export interface RowGroup {
  key: string
  label: string
  count: number
  items: FindingListItem[]
}

/**
 * Splits the loaded rows into their groups. Rows arrive group by group and `groups` holds every
 * group's size over all pages, so position alone says which group a row belongs to.
 */
export function splitGroups(
  items: readonly FindingListItem[],
  response: Pick<FindingsResponse, 'groups'>,
): RowGroup[] {
  if (response.groups.length === 0)
    return [{ key: 'all', label: '', count: items.length, items: [...items] }]
  const out: RowGroup[] = []
  let index = 0
  for (const group of response.groups) {
    if (index >= items.length) break
    const slice = items.slice(index, index + group.count)
    out.push({ ...group, items: slice })
    index += group.count
  }
  return out
}
