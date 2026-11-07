import { findingStateSchema, guardCheckSchema, guardLevelSchema } from '@hinomi/shared'
import { z } from 'zod'
import { splitSearchSchema } from './split-search'
import type { FindingsParams } from './view-api'

const list = <T extends z.ZodType>(item: T) => z.array(item).optional().catch(undefined)

/** Search params of /guards: the check, level and state filters, so a filtered view is a link. */
export const guardsSearchSchema = z
  .object({
    check: list(guardCheckSchema),
    level: list(guardLevelSchema),
    state: list(findingStateSchema),
  })
  .extend(splitSearchSchema.shape)

export type GuardsSearch = z.infer<typeof guardsSearchSchema>

/** Guard findings only, grouped by tier like every other finding (decision Q2). */
export function guardsParams(search: GuardsSearch, limit: number): FindingsParams {
  return {
    kind: ['guard'],
    check: search.check,
    level: search.level,
    state: search.state,
    group: 'tier',
    limit,
  }
}

export function hasGuardFilters(search: GuardsSearch): boolean {
  return Boolean(search.check?.length || search.level?.length || search.state?.length)
}
