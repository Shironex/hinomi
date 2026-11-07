import {
  isMajorStep,
  type FindingState,
  type FixPlan,
  type FixResultV1,
  type FixRunKind,
  type FixRunDeployment,
  type FixRunVerification,
  type FixRunVerifyAfter,
  type FixRunWarning,
  watchPathsTrigger,
} from '@hinomi/shared'
import type { DeploymentRow, FixRunRow } from '../db/schema.js'

// Pure parts of linking a merged fix run to its deployments and verifying it: the watch path
// warning, the findings a run targeted, and how they came out of a rescan.

/**
 * The watch path warning for one app, or null: the app has watch paths and none of the files
 * the fix changed would trigger a deploy.
 */
export function watchPathsWarning(
  app: Pick<DeploymentRow, 'id' | 'name' | 'watchPaths'>,
  files: readonly string[],
  at: Date,
): FixRunWarning | null {
  const patterns = app.watchPaths ?? []
  if (patterns.length === 0 || files.length === 0) return null
  if (files.some((file) => watchPathsTrigger(patterns, file))) return null
  const shown =
    files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '')
  return {
    code: 'watch_paths_skip',
    deploymentId: app.id,
    message: `The watch paths of ${app.name} (${patterns.join(', ')}) match none of the files the fix changed (${shown}), so this deploy may not happen automatically. Deploy it by hand in Coolify.`,
    at: at.toISOString(),
  }
}

/** Result statuses of a step that count as targeted: applied, or found already fixed. */
const TARGETED_SKIPS = new Set(['already_fixed', 'no_longer_vulnerable'])

/**
 * The findings a run targeted: those of the plan's safe steps the runner applied (or found
 * already fixed). Without a result, every safe step. A majors run targets the major upgrades
 * handed to the agent instead, those whose lockfile its patch changed. Null when the plan is
 * gone.
 */
export function targetedFindingIds(
  plan: FixPlan | null,
  result: FixResultV1 | null,
  kind: FixRunKind = 'fix',
): number[] | null {
  if (!plan) return null
  const safe = plan.steps.filter((step) =>
    kind === 'majors' ? isMajorStep(step) : step.risk === 'safe',
  )
  const statusOf = new Map(result?.steps.map((step) => [step.id, step]) ?? [])
  const steps = result
    ? safe.filter((step) => {
        const done = statusOf.get(step.id)
        if (!done) return false
        return (
          done.status === 'applied' || (done.reason !== null && TARGETED_SKIPS.has(done.reason))
        )
      })
    : safe
  return [...new Set(steps.flatMap((step) => step.findingIds))].sort((a, b) => a - b)
}

/** How the targeted findings came out of a rescan. */
export interface TargetComparison {
  cleared: number[]
  stillOpen: number[]
  new: number[]
}

/**
 * Splits the targeted findings by their state after the rescan: fixed or gone is cleared,
 * anything else (open, snoozed, accepted, dismissed upstream) is still open. `opened` are the
 * findings the rescan opened or reopened; the targeted ones are left out of `new`.
 */
export function compareTargets(
  targeted: readonly number[],
  stateOf: (findingId: number) => FindingState | undefined,
  opened: readonly number[],
): TargetComparison {
  const cleared: number[] = []
  const stillOpen: number[] = []
  for (const id of targeted) {
    const state = stateOf(id)
    if (state === undefined || state === 'fixed') cleared.push(id)
    else stillOpen.push(id)
  }
  const target = new Set(targeted)
  const fresh = [...new Set(opened)].filter((id) => !target.has(id)).sort((a, b) => a - b)
  return { cleared, stillOpen, new: fresh }
}

/** What the verification of a run waits for, from its state. */
export function verifyAfter(run: Pick<FixRunRow, 'state'>): FixRunVerifyAfter {
  if (run.state === 'nothing_to_do') return 'empty_diff'
  if (run.state === 'deployed') return 'deploy'
  return 'merge'
}

/** When the run became ready to verify: a scan that started earlier does not count. */
export function readySince(run: FixRunRow): Date {
  if (run.state === 'deployed') return run.deployedAt ?? run.stateChangedAt
  if (run.state === 'merged') return run.mergedAt ?? run.stateChangedAt
  return run.stateChangedAt
}

/** A fresh verification record for a run that starts waiting for its rescan. */
export function pendingVerification(run: FixRunRow): FixRunVerification {
  return (
    run.verification ?? {
      after: verifyAfter(run),
      status: 'pending',
      scan: null,
      targeted: [],
      cleared: [],
      stillOpen: [],
      new: [],
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
    }
  )
}

/** A deploy link that has not shipped yet, for an app seen for the first time. */
export function waitingLink(app: DeploymentRow): FixRunDeployment {
  return {
    deploymentId: app.id,
    name: app.name,
    branch: app.gitBranch,
    status: 'waiting',
    deploy: null,
    checkedAt: null,
    error: null,
  }
}
