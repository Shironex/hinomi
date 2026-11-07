import {
  FixPayloadError,
  isFixRunTerminal,
  parseFixResult,
  type FixResultV1,
  type RunnerCallbackStatus,
} from '@hinomi/shared'
import type { FixRunRow, RepoRow } from '../db/schema.js'
import { transitionFixRun, type FixRunEvent, type Repositories } from '../repository/index.js'
import { GithubError, fetchBranchHead } from '../sources/github/index.js'
import { clipReason } from './dispatch.js'
import type { RunnerGithub } from './github.js'
import { majorsFailureReason } from './tracker-poll.js'

// What a runner that is not polled on GitHub reports about a run (the webhook runner's callback,
// the local runner's process), turned into the same state machine events the tracker sends for
// a GitHub Actions run: queued, running, a result with or without a pushed branch, a failure or
// a cancellation. From `branch_pushed` on the tracker takes over as for any run.

/** A report about one run, its result not validated yet. */
export interface RunReport {
  status: RunnerCallbackStatus
  result?: unknown
  headSha?: string
  reason?: string
}

export type RunReportOutcome =
  /** `applied` changed the run, `unchanged` repeated what it already recorded. */
  | { kind: 'applied' | 'unchanged'; run: FixRunRow }
  | { kind: 'invalid'; message: string }
  | { kind: 'conflict'; message: string }
  /** GitHub could not be asked about the branch; the report can be sent again. */
  | { kind: 'unavailable'; message: string }

export interface RunReportContext {
  repositories: Repositories
  github: () => RunnerGithub
  now: () => Date
}

/** A reason from outside Hinomi as one clean line. */
export function cleanReason(text: string): string {
  return clipReason(
    text
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function readResult(
  run: FixRunRow,
  repo: RepoRow,
  raw: unknown,
): { ok: true; result: FixResultV1 } | { ok: false; message: string } {
  let result: FixResultV1
  try {
    result = parseFixResult(raw)
  } catch (error) {
    if (!(error instanceof FixPayloadError)) throw error
    return { ok: false, message: `The result is not a valid fix result: ${error.message}` }
  }
  if (result.runId !== run.correlationId) {
    return {
      ok: false,
      message: `The result is for run ${result.runId}, not ${run.correlationId}.`,
    }
  }
  if (result.repo.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) {
    return {
      ok: false,
      message: `The result is for ${result.repo}, not ${repo.owner}/${repo.name}.`,
    }
  }
  return { ok: true, result }
}

function applied(
  context: RunReportContext,
  run: FixRunRow,
  event: FixRunEvent,
  result: FixResultV1 | null,
): RunReportOutcome {
  const { fixRuns } = context.repositories
  // Checked first, so a refused report never replaces the result a run already stored.
  const preview = transitionFixRun(run, event, context.now())
  if (!preview.ok) return { kind: 'conflict', message: preview.rejection.message }
  if (isFixRunTerminal(run.state)) return { kind: 'unchanged', run }
  if (result) fixRuns.setResult(run.id, result)
  const moved = fixRuns.applyEvent(run.id, event, context.now())
  if (!moved.ok) return { kind: 'conflict', message: moved.rejection.message }
  return { kind: moved.changed ? 'applied' : 'unchanged', run: moved.run }
}

/** The pushed branch must be on GitHub at the head the runner names. */
async function checkHead(
  context: RunReportContext,
  run: FixRunRow,
  repo: RepoRow,
  headSha: string,
): Promise<RunReportOutcome | null> {
  const github = context.github()
  if (!github.ok) return { kind: 'unavailable', message: github.message }
  let head: string | null
  try {
    head = await fetchBranchHead(github.source.client, repo.owner, repo.name, run.branch)
  } catch (error) {
    const detail = error instanceof GithubError ? error.message : String(error)
    return {
      kind: 'unavailable',
      message: `GitHub could not be asked about ${run.branch}: ${detail}`,
    }
  }
  if (head === null) {
    return { kind: 'conflict', message: `${run.branch} is not on ${repo.owner}/${repo.name}.` }
  }
  if (head !== headSha) {
    return {
      kind: 'conflict',
      message: `${run.branch} is at ${head} on GitHub, not at ${headSha}.`,
    }
  }
  return null
}

/** Applies one report to its run. Never throws for a bad report; GitHub errors are `unavailable`. */
export async function applyRunReport(
  context: RunReportContext,
  run: FixRunRow,
  report: RunReport,
): Promise<RunReportOutcome> {
  const repo = context.repositories.repos.get(run.repoId)
  if (!repo) return { kind: 'conflict', message: 'The run has no repo any more.' }
  switch (report.status) {
    case 'queued':
      return applied(context, run, { type: 'run_queued' }, null)
    case 'running':
      return applied(context, run, { type: 'run_started' }, null)
    case 'cancelled':
      return applied(context, run, { type: 'run_completed', conclusion: 'cancelled' }, null)
    case 'failed': {
      // A result sent with a failure is kept for the run page when it is valid.
      const read = report.result === undefined ? null : readResult(run, repo, report.result)
      const reason = report.reason ? cleanReason(report.reason) : ''
      return applied(
        context,
        run,
        {
          type: 'failed',
          reason: reason || `The ${run.runner} runner reported a failure without a reason.`,
        },
        read?.ok ? read.result : null,
      )
    }
    case 'completed':
      break
  }
  if (report.result === undefined) {
    return { kind: 'invalid', message: 'A completed report needs the result.' }
  }
  const read = readResult(run, repo, report.result)
  if (!read.ok) return { kind: 'invalid', message: read.message }
  const { result } = read
  if (result.patch === null) {
    if (run.kind === 'majors') {
      return applied(context, run, { type: 'failed', reason: majorsFailureReason(result) }, result)
    }
    const event: FixRunEvent = { type: 'run_completed', conclusion: 'success', nothingToDo: true }
    return applied(context, run, event, result)
  }
  if (!report.headSha) {
    return {
      kind: 'invalid',
      message: 'A result with a patch needs the headSha of the pushed branch.',
    }
  }
  const problem = await checkHead(context, run, repo, report.headSha)
  if (problem) return problem
  const event: FixRunEvent = {
    type: 'run_completed',
    conclusion: 'success',
    headSha: report.headSha,
  }
  return applied(context, run, event, result)
}
