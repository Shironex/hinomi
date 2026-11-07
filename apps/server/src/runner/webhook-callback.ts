import type { RunnerCallback } from '@hinomi/shared'
import { applyRunReport, type RunReportContext, type RunReportOutcome } from './report.js'

// The webhook runner's callback, once its signature and replay checks passed (the receiver in
// the webhook folder): finds the run by the correlation id Hinomi sent, only among webhook runs,
// and applies the report. A run that reached `branch_pushed` is handed to the tracker at once.

export type RunnerCallbackOutcome = RunReportOutcome | { kind: 'not_found'; message: string }

export interface RunnerCallbackContext extends RunReportContext {
  /** Makes the tracker poll this run now (the publish phase opens the PR). */
  pollNow?: (runId: number) => void
}

export async function handleRunnerCallback(
  context: RunnerCallbackContext,
  callback: RunnerCallback,
): Promise<RunnerCallbackOutcome> {
  const run = context.repositories.fixRuns.getByCorrelationId(callback.runId)
  if (!run || run.runner !== 'webhook') {
    return { kind: 'not_found', message: 'No webhook runner run has this id.' }
  }
  const outcome = await applyRunReport(context, run, {
    status: callback.status,
    ...(callback.result !== undefined && { result: callback.result }),
    ...(callback.headSha !== undefined && { headSha: callback.headSha }),
    ...(callback.reason !== undefined && { reason: callback.reason }),
  })
  if (outcome.kind === 'applied' && outcome.run.state === 'branch_pushed') {
    context.pollNow?.(outcome.run.id)
  }
  return outcome
}

/** What the receiver needs: the outcome with the run's state, or the refusal. */
export type RunnerCallbackAnswer =
  | { kind: 'applied' | 'unchanged'; state: string }
  | { kind: 'not_found' | 'invalid' | 'conflict' | 'unavailable'; message: string }

/** handleRunnerCallback bound to its context, answering in the receiver's terms. */
export function createRunnerCallbackHandler(
  context: RunnerCallbackContext,
): (callback: RunnerCallback) => Promise<RunnerCallbackAnswer> {
  return async (callback) => {
    const outcome = await handleRunnerCallback(context, callback)
    if ('run' in outcome) return { kind: outcome.kind, state: outcome.run.state }
    return { kind: outcome.kind, message: outcome.message }
  }
}
