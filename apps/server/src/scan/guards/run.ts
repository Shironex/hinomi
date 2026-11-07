import type { Repositories } from '../../repository/index.js'
import type { FindingChange } from '../apply.js'
import { loadOverrideIndex } from '../overrides.js'
import { applyGuards, evaluateGuards } from './apply.js'
import type { Guard, GuardContext } from './types.js'

/** Runs the checks, then writes their findings and applies the check overrides. */
export async function runGuards(
  repositories: Repositories,
  guards: readonly Guard[],
  ctx: GuardContext,
  log: { warn(message: string, data?: Record<string, unknown>): void },
): Promise<FindingChange[]> {
  if (guards.length === 0) return []
  const outcomes = await evaluateGuards(guards, ctx, log)
  return applyGuards(repositories, outcomes, loadOverrideIndex(repositories, ctx.index), ctx.now)
}
