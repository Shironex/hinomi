import {
  type FindingListItem,
  type FindingsResponse,
  findingGroupSchema,
  findingScopeSchema,
  findingStateSchema,
  findingTierSchema,
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
  state: list(findingStateSchema),
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
    state: search.state,
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
    search.repo?.length ||
    search.deployment?.length ||
    search.q?.trim(),
  )
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
