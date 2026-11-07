import { z } from 'zod'
import { FIX_BRANCH } from './runner-pr.js'
import { fixChecksModeSchema, fixResultV1Schema } from './runner.js'

// Fix runs: one dispatch of a fix plan to a runner, tracked from the dispatch to a rescan that
// verifies the findings are gone. The server stores these strings in SQLite (fix_runs); the API
// and the SPA validate against the same lists.

/**
 * Lifecycle of a fix run. The happy path is
 * `pending, dispatched, queued, running, branch_pushed, pr_open, checks_pending,
 * checks_passing, merged, deployed, verified`. Polling may skip states (a run seen for the first
 * time after it finished), so a run may jump forward but never moves back.
 *
 * - `pending`: the row exists, the runner has not accepted the dispatch yet.
 * - `nothing_to_do`: the plan produced an empty diff; no branch, no PR. Waits for a rescan.
 * - `checks_failing`: the PR stays a draft with the failure output (decision 3 of the runner design).
 * - `checks_none`: the repo runs no checks on the PR.
 * - `merged`: waits for a deployment of the merge commit, or straight for a rescan.
 * - `closed_unmerged`: the PR was closed without merging. Hinomi asks before dispatching again.
 * - `superseded`: a newer dispatch for the same repo and kind took over before this one merged.
 * - `lost`: polling gave up on a run that never finished (job timeout plus a grace period).
 */
export const FIX_RUN_STATES = [
  'pending',
  'dispatched',
  'queued',
  'running',
  'branch_pushed',
  'pr_open',
  'checks_pending',
  'checks_passing',
  'checks_failing',
  'checks_none',
  'merged',
  'deployed',
  'nothing_to_do',
  'verified',
  'not_cleared',
  'failed',
  'cancelled',
  'closed_unmerged',
  'superseded',
  'lost',
] as const
export const fixRunStateSchema = z.enum(FIX_RUN_STATES)
export type FixRunState = z.infer<typeof fixRunStateSchema>

/**
 * States where a run has ended. Three can come back: a closed PR that is reopened
 * (`closed_unmerged` to `pr_open`) and a failed or cancelled workflow run that is re-run on
 * GitHub (`failed` or `cancelled` to `queued` or `running`, same run id, a new attempt). The
 * others never change again.
 */
export const FIX_RUN_TERMINAL_STATES = [
  'verified',
  'not_cleared',
  'failed',
  'cancelled',
  'closed_unmerged',
  'superseded',
  'lost',
] as const satisfies readonly FixRunState[]

/** True when the run has ended (see FIX_RUN_TERMINAL_STATES for the three that can come back). */
export function isFixRunTerminal(state: FixRunState): boolean {
  return (FIX_RUN_TERMINAL_STATES as readonly FixRunState[]).includes(state)
}

/**
 * Where the fix plan runs. Only `github_actions` exists today; the `webhook` and `local` runners
 * come later and are listed so the column does not need a migration when they land.
 */
export const FIX_RUNNER_KINDS = ['github_actions', 'webhook', 'local'] as const
export const fixRunnerKindSchema = z.enum(FIX_RUNNER_KINDS)
export type FixRunnerKind = z.infer<typeof fixRunnerKindSchema>

/** `fix` applies the safe steps of a plan; `majors` is the agent hand off for risky majors. */
export const FIX_RUN_KINDS = ['fix', 'majors'] as const
export const fixRunKindSchema = z.enum(FIX_RUN_KINDS)
export type FixRunKind = z.infer<typeof fixRunKindSchema>

/** The branch a run of each kind pushes. One per repo, so a new dispatch reuses it. */
export const FIX_RUN_BRANCHES: Record<FixRunKind, string> = {
  fix: FIX_BRANCH,
  majors: 'hinomi/majors',
}

const isoDate = z.iso.datetime({ offset: true })
const id = z.number().int().positive()

/** A fix run as the API serves it. */
export const fixRunSchema = z.object({
  id,
  repoId: id,
  /** The plan the run applies. `fixPlanId` is null once the plan row was pruned. */
  plan: z.object({
    fixPlanId: id.nullable(),
    scanRunId: id,
    version: z.number().int().positive(),
  }),
  runner: fixRunnerKindSchema,
  kind: fixRunKindSchema,
  /** Sent with the dispatch and in the run name, so a run can be matched without its id. */
  correlationId: z.string(),
  branch: z.string(),
  /** Checks inside the runner (`full` on public repos, `install` on private ones). */
  checksMode: fixChecksModeSchema,
  state: fixRunStateSchema,
  /** Why the run is in its state, for failed, lost, cancelled and not cleared runs. */
  stateReason: z.string().nullable(),
  terminal: z.boolean(),
  /** The workflow run on GitHub, once known. */
  github: z
    .object({
      runId: id,
      runAttempt: z.number().int().positive().nullable(),
    })
    .nullable(),
  /** Commit at the head of the pushed branch. */
  headSha: z.string().nullable(),
  pr: z
    .object({
      number: id,
      url: z.string(),
      draft: z.boolean(),
      mergeSha: z.string().nullable(),
    })
    .nullable(),
  /** What the runner reported (filled once the run finished and its result was read). */
  result: fixResultV1Schema.nullable(),
  /** When each step happened. Null until the run got there. */
  at: z.object({
    created: isoDate,
    dispatched: isoDate.nullable(),
    started: isoDate.nullable(),
    completed: isoDate.nullable(),
    pushed: isoDate.nullable(),
    prOpened: isoDate.nullable(),
    checksUpdated: isoDate.nullable(),
    merged: isoDate.nullable(),
    closed: isoDate.nullable(),
    deployed: isoDate.nullable(),
    rescanned: isoDate.nullable(),
    ended: isoDate.nullable(),
    stateChanged: isoDate,
  }),
})
export type FixRun = z.infer<typeof fixRunSchema>

/**
 * What the fix run tracker knows about a run. Kept in memory, so it is null after a restart until
 * the tracker looked at the run again, and for runs it no longer follows.
 */
export const fixRunTrackingSchema = z.object({
  lastPolledAt: isoDate.nullable(),
  /** Null when the run is no longer polled (it ended, or waits for a deployment or rescan). */
  nextPollAt: isoDate.nullable(),
  /** The last GitHub error or refusal while polling, cleared by the next good poll. */
  lastError: z.string().nullable(),
  /** Set while polling waits for GitHub's rate limit window. */
  pausedUntil: isoDate.nullable(),
})
export type FixRunTracking = z.infer<typeof fixRunTrackingSchema>

/** GET /api/fix-runs/:id: the run and its tracking state. */
export const fixRunDetailSchema = fixRunSchema.extend({
  tracking: fixRunTrackingSchema.nullable(),
})
export type FixRunDetail = z.infer<typeof fixRunDetailSchema>
