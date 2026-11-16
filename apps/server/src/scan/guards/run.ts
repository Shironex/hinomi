import type { Repositories } from '../../repository/index.js'
import type { FindingChange } from '../apply.js'
import { loadOverrideIndex } from '../overrides.js'
import { applyGuards, evaluateGuards } from './apply.js'
import { handOverArchivedBlindSpots } from './archived-handover.js'
import type { Guard, GuardContext } from './types.js'

/** Runs the checks, then writes their findings and applies the check overrides. */
export async function runGuards(
  repositories: Repositories,
  guards: readonly Guard[],
  ctx: GuardContext,
  log: { warn(message: string, data?: Record<string, unknown>): void },
): Promise<FindingChange[]> {
  if (guards.length === 0) return []
  const overrides = loadOverrideIndex(repositories, ctx.index)
  const outcomes = await evaluateGuards(guards, { ...ctx, overrides }, log)
  const changes = applyGuards(repositories, outcomes, overrides, ctx.now)
  return handOverArchivedBlindSpots(repositories, outcomes, ctx.index, ctx.now, changes)
}
