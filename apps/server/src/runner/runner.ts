import type { FixDispatchEncoding, FixRunKind, FixRunnerKind } from '@hinomi/shared'
import type { FixPlanRow, FixRunRow, RepoRow } from '../db/schema.js'

// The contract every fix runner implements: GitHub Actions now, the webhook and local runners
// later. A runner turns a stored fix plan into a fix_runs row and hands the plan to whatever
// applies it. The checks that do not depend on the runner (enabled, a plan exists, decision 10
// on a closed unmerged PR) run before it, in service.ts.

export interface FixRunDispatchRequest {
  repo: RepoRow
  /** The plan to apply, normally the repo's latest. */
  plan: FixPlanRow
  /**
   * `fix` (default): the plan's safe steps, for the fix PR. `majors`: the plan's major upgrades
   * for the optional coding agent, a separate run and dispatch with its own branch and PR.
   */
  kind?: FixRunKind
}

/** A dispatch the runner refused before it created a run. */
export interface FixRunDispatchRefusal {
  created: false
  /**
   * `no_source`: nothing to talk to (no GitHub source). `nothing_to_send`: the plan has no safe
   * step the runner can apply (for `majors`: no major upgrade for the agent). `plan`: the plan or its payload is not valid. `unavailable`: the
   * repo could not be read before dispatching.
   */
  code: 'no_source' | 'nothing_to_send' | 'plan' | 'unavailable'
  message: string
}

/** A run row exists. It may already be `failed` when the runner refused the dispatch. */
export interface FixRunDispatchCreated {
  created: true
  run: FixRunRow
  encoding: FixDispatchEncoding
  /** Plan step ids the payload budget left out. */
  omittedStepIds: string[]
}

export type FixRunDispatchOutcome = FixRunDispatchCreated | FixRunDispatchRefusal

export interface FixRunner {
  readonly kind: FixRunnerKind
  /**
   * Records the run as `pending`, then hands the plan over. Moves the run to `dispatched` when
   * the runner accepted it, or to `failed` with a reason a person can act on.
   */
  dispatch(request: FixRunDispatchRequest): Promise<FixRunDispatchOutcome>
}
