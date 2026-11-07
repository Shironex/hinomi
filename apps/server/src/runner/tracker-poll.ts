import { FixPayloadError, fixRunName, type FixResultV1 } from '@hinomi/shared'
import { z } from 'zod'
import type { FixRunRow, RepoRow } from '../db/schema.js'
import type { Logger } from '../log.js'
import type { FixRunEvent, Repositories } from '../repository/index.js'
import {
  GithubError,
  combineChecks,
  downloadArtifact,
  fetchBranchHead,
  fetchCheckRunsStatus,
  fetchCombinedStatus,
  fetchPull,
  fetchWorkflowRun,
  listRunArtifacts,
  listWorkflowRuns,
  type GithubArtifact,
  type GithubChecksStatus,
  type GithubClient,
  type GithubCompareStatus,
  type GithubPull,
  type GithubWorkflowRun,
} from '../sources/github/index.js'
import { MAX_RESULT_ARTIFACT_BYTES, fixResultArtifactNames, readFixResultZip } from './artifact.js'
import { callerWorkflowOf } from './github-actions.js'
import type { RunnerGithub } from './github.js'
import { publishFixPr, type PublishFixPrOutcome } from './publisher.js'
import { pollDeployments, verifyRun, type RepoRescanner } from './tracker-verify.js'
import {
  TRACKED_PR_STATES,
  dispatchTime,
  lostReason,
  publishRetryDelayMs,
  type FixRunTrackingConfig,
  type TrackingPhase,
} from './tracking.js'

// One poll of one fix run, per phase (see tracking.ts): link a run by its run name, follow the
// workflow run and read its result artifact, open the fix PR, follow the PR and its checks, and
// watch recently ended runs for a re-run or a reopened PR. Every state change goes through
// fixRuns.applyEvent; ETags are stored only once their answer was fully handled, so a 304 never
// hides work that is still to do.

/** What the tracker remembers about a run between polls (in memory). */
export interface RunTrackingState {
  lastPolledAt: Date | null
  lastError: string | null
  /** Transient publish failures in a row. */
  publishAttempts: number
  /** Set after a transient publish failure: the run is due again at this time. */
  retryAt: Date | null
}

export interface PollContext {
  repositories: Repositories
  client: GithubClient
  /** The same source as `client`, for the publisher. */
  github: () => RunnerGithub
  fetch: typeof fetch | undefined
  now: () => Date
  log: Logger
  config: FixRunTrackingConfig
  publicBaseUrl: (() => string | null) | undefined
  state: RunTrackingState
  /** Rescans a repo for verification; without it the verify phase is not followed. */
  rescan: RepoRescanner | undefined
  /** Compare answers of the deploy link, kept by the tracker. */
  compareCache: Map<string, GithubCompareStatus | null>
}

/** Workflow run statuses that mean waiting for a runner. */
const QUEUED_STATUSES = new Set(['queued', 'waiting', 'requested', 'pending'])

type Conclusion = 'success' | 'failure' | 'cancelled' | 'timed_out'

/** A finished run's conclusion as the state machine tells them apart. */
export function conclusionOf(raw: string | null): Conclusion {
  if (raw === 'success' || raw === 'cancelled' || raw === 'timed_out') return raw
  return 'failure'
}

/** Applies an event and logs real changes. A refusal is logged and the run left as it was. */
function apply(context: PollContext, run: FixRunRow, event: FixRunEvent): FixRunRow {
  const result = context.repositories.fixRuns.applyEvent(run.id, event, context.now())
  if (!result.ok) {
    if (result.rejection.code === 'conflict') {
      context.log.warn('tracker: a fix run event was refused', {
        runId: run.id,
        event: event.type,
        reason: result.rejection.message,
      })
    }
    return context.repositories.fixRuns.get(run.id) ?? run
  }
  if (result.changed && result.run.state !== run.state) {
    context.log.info('tracker: fix run moved', {
      runId: run.id,
      from: run.state,
      to: result.run.state,
      event: event.type,
    })
  }
  return result.run
}

function repoOf(context: PollContext, run: FixRunRow): RepoRow | undefined {
  return context.repositories.repos.get(run.repoId)
}

// ---------------------------------------------------------------------------
// Workflow runs

/** Gives up on a run GitHub still reports unfinished for too long. */
function checkLost(context: PollContext, run: FixRunRow): FixRunRow {
  const reason = lostReason(run, context.now(), context.config)
  return reason ? apply(context, run, { type: 'lost', reason }) : run
}

/**
 * Finds the workflow run of a dispatch that came back without its id (GitHub answered 204, or
 * the dispatch call failed in transit), by its run name among the caller workflow's dispatch
 * runs created since a minute before the dispatch. Lost after the link window.
 */
async function linkRun(context: PollContext, run: FixRunRow, repo: RepoRow): Promise<void> {
  const since = new Date(dispatchTime(run).getTime() - 60_000)
  const runs = await listWorkflowRuns(context.client, {
    owner: repo.owner,
    name: repo.name,
    workflow: callerWorkflowOf(repo),
    createdSince: since,
  })
  const title = fixRunName(run.correlationId)
  const match = runs.filter((r) => r.title === title).sort((a, b) => a.id - b.id)[0]
  if (!match) {
    const waited = context.now().getTime() - dispatchTime(run).getTime()
    if (waited > context.config.linkWindowMs) {
      const minutes = Math.round(context.config.linkWindowMs / 60_000)
      apply(context, run, {
        type: 'lost',
        reason: `No workflow run named "${title}" appeared on ${repo.owner}/${repo.name} within ${minutes} minutes of the dispatch.`,
      })
    }
    return
  }
  const linked = apply(context, run, {
    type: 'run_linked',
    githubRunId: match.id,
    githubRunAttempt: match.attempt,
  })
  if (linked.githubRunId !== match.id) return
  await followWorkflowRun(context, linked, repo, match, false)
}

/** Follows a run whose GitHub run id is known; `ended` watches a failed or cancelled run. */
async function pollWorkflowRun(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  ended: boolean,
): Promise<void> {
  const runId = run.githubRunId
  if (runId === null) return
  const read = await fetchWorkflowRun(context.client, repo.owner, repo.name, runId, run.runEtag)
  if (read === null) {
    if (!ended) {
      apply(context, run, {
        type: 'lost',
        reason: `Workflow run ${runId} is gone from ${repo.owner}/${repo.name} (deleted, or no longer visible to the credential).`,
      })
    }
    return
  }
  if (!read.modified) {
    if (!ended) checkLost(context, run)
    return
  }
  const handled = await followWorkflowRun(context, run, repo, read.value, ended)
  context.repositories.fixRuns.setEtags(run.id, { run: handled ? read.etag : null })
}

/**
 * Applies what GitHub reports about the workflow run. Returns false when the run completed but
 * its result could not be read yet, so the next poll asks again without an ETag.
 */
async function followWorkflowRun(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  remote: GithubWorkflowRun,
  ended: boolean,
): Promise<boolean> {
  const identity = { githubRunId: remote.id, githubRunAttempt: remote.attempt }
  let current = run
  if (ended) {
    // Only a re-run of the same workflow run (a higher attempt) brings an ended run back.
    if (remote.attempt <= (run.githubRunAttempt ?? 1)) return true
    const type = QUEUED_STATUSES.has(remote.status) ? 'run_queued' : 'run_started'
    current = apply(context, run, { type, ...identity })
    if (current.state === run.state) return true
    context.log.info('tracker: a re-run brought the fix run back', {
      runId: run.id,
      attempt: remote.attempt,
    })
    context.state.publishAttempts = 0
  }
  if (QUEUED_STATUSES.has(remote.status)) {
    checkLost(context, apply(context, current, { type: 'run_queued', ...identity }))
    return true
  }
  if (remote.status !== 'completed') {
    checkLost(context, apply(context, current, { type: 'run_started', ...identity }))
    return true
  }
  return completeRun(context, current, repo, remote)
}

/** The run's result artifact: the newest unexpired one with an expected name. */
function pickArtifact(artifacts: GithubArtifact[], run: FixRunRow): GithubArtifact | null {
  for (const name of fixResultArtifactNames(run.correlationId, run.kind)) {
    const found = artifacts
      .filter((a) => a.name === name && !a.expired)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id)[0]
    if (found) return found
  }
  return null
}

type ResultRead =
  { kind: 'read'; result: FixResultV1 } | { kind: 'missing' } | { kind: 'unusable'; reason: string }

/** Downloads and validates the result artifact. Transient GitHub errors are thrown. */
async function readResult(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  remote: GithubWorkflowRun,
): Promise<ResultRead> {
  const artifacts = await listRunArtifacts(context.client, repo.owner, repo.name, remote.id)
  const artifact = pickArtifact(artifacts, run)
  if (!artifact) return { kind: 'missing' }
  if (artifact.sizeInBytes > MAX_RESULT_ARTIFACT_BYTES) {
    return {
      kind: 'unusable',
      reason: `The result artifact ${artifact.name} is ${artifact.sizeInBytes} bytes, more than the ${MAX_RESULT_ARTIFACT_BYTES} Hinomi reads.`,
    }
  }
  try {
    const zip = await downloadArtifact(
      context.client,
      { owner: repo.owner, name: repo.name, artifactId: artifact.id },
      {
        maxBytes: MAX_RESULT_ARTIFACT_BYTES,
        ...(context.fetch && { fetch: context.fetch }),
      },
    )
    const result = readFixResultZip(zip)
    if (result.runId !== run.correlationId) {
      return {
        kind: 'unusable',
        reason: `The result artifact is for run ${result.runId}, not ${run.correlationId}.`,
      }
    }
    return { kind: 'read', result }
  } catch (error) {
    if (error instanceof FixPayloadError) {
      return { kind: 'unusable', reason: `The result artifact cannot be used: ${error.message}` }
    }
    if (error instanceof GithubError && (error.kind === 'not_found' || error.kind === 'parse')) {
      return {
        kind: 'unusable',
        reason: `The result artifact could not be downloaded: ${error.message}`,
      }
    }
    throw error
  }
}

/** Why a majors run left no patch, from the agent report. */
export function majorsFailureReason(result: FixResultV1): string {
  const agent = result.agent
  if (!agent) return 'The majors job wrote no agent report.'
  const detail = agent.detail ? `: ${agent.detail}` : ''
  switch (agent.outcome) {
    case 'no_changes':
      return 'The coding agent finished without changing any file it may change.'
    case 'timeout':
      return `The coding agent ran out of time and changed nothing${detail}.`
    case 'refused':
      return `The coding agent's changes were refused${detail}.`
    default:
      return `The coding agent failed${detail}.`
  }
}

/**
 * A completed workflow run: reads the result artifact first (agreed with the state machine:
 * `run_completed` is sent only once the result is known), stores it, then ends the run
 * (`failed`, `cancelled`, `nothing_to_do`) or records the pushed branch and opens the PR.
 */
async function completeRun(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  remote: GithubWorkflowRun,
): Promise<boolean> {
  const conclusion = conclusionOf(remote.conclusion)
  const identity = { githubRunId: remote.id, githubRunAttempt: remote.attempt }
  const read = await readResult(context, run, repo, remote)
  if (read.kind === 'read') context.repositories.fixRuns.setResult(run.id, read.result)

  if (conclusion !== 'success') {
    // The result, when there is one, is kept for the run page; the run ends either way.
    apply(context, run, { type: 'run_completed', conclusion, ...identity })
    return true
  }
  if (read.kind === 'missing') {
    const finished = Date.parse(remote.updatedAt ?? remote.createdAt)
    if (context.now().getTime() - finished < context.config.artifactWaitMs) return false
    const [name] = fixResultArtifactNames(run.correlationId, run.kind)
    apply(context, run, {
      type: 'failed',
      reason: `The workflow run finished without its result artifact ${name}.`,
    })
    return true
  }
  if (read.kind === 'unusable') {
    apply(context, run, { type: 'failed', reason: read.reason })
    return true
  }
  if (read.result.patch === null && run.kind === 'majors') {
    // The agent was asked to change something; no patch is a failure a person should see.
    apply(context, run, { type: 'failed', reason: majorsFailureReason(read.result) })
    return true
  }
  if (read.result.patch === null) {
    apply(context, run, { type: 'run_completed', conclusion, nothingToDo: true, ...identity })
    return true
  }
  const headSha = await fetchBranchHead(context.client, repo.owner, repo.name, run.branch)
  if (!headSha) {
    apply(context, run, {
      type: 'failed',
      reason: `The workflow run reported changes, but ${run.branch} is not on ${repo.owner}/${repo.name}.`,
    })
    return true
  }
  const pushed = apply(context, run, { type: 'run_completed', conclusion, headSha, ...identity })
  if (pushed.state === 'branch_pushed') await publish(context, pushed)
  return true
}

// ---------------------------------------------------------------------------
// The fix PR

/** Opens or updates the fix PR from the stored result, and handles each publish outcome. */
async function publish(context: PollContext, run: FixRunRow): Promise<PublishFixPrOutcome | null> {
  const { state } = context
  if (!run.result || !run.headSha) {
    apply(context, run, {
      type: 'failed',
      reason:
        'The branch was pushed but Hinomi has no result for this run, so the PR body cannot be written.',
    })
    return null
  }
  const outcome = await publishFixPr(
    {
      repositories: context.repositories,
      github: context.github,
      now: context.now,
      ...(context.publicBaseUrl && { publicBaseUrl: context.publicBaseUrl }),
    },
    run,
    run.result,
    run.headSha,
  )
  switch (outcome.kind) {
    case 'published':
      state.publishAttempts = 0
      state.retryAt = null
      context.log.info('tracker: fix PR published', {
        runId: run.id,
        pr: outcome.pr.number,
        action: outcome.action,
        warnings: outcome.warnings.length,
      })
      break
    case 'reopen_required':
      state.retryAt = null
      context.log.info('tracker: the fix PR was closed unmerged; the next dispatch asks first', {
        runId: run.id,
        pr: outcome.previous.number,
      })
      break
    case 'skipped':
      state.retryAt = null
      break
    case 'retry': {
      state.publishAttempts += 1
      state.lastError = outcome.reason
      if (state.publishAttempts >= context.config.publishMaxAttempts) {
        state.retryAt = null
        apply(context, outcome.run, {
          type: 'failed',
          reason: `The fix PR could not be opened after ${state.publishAttempts} tries: ${outcome.reason}`,
        })
        break
      }
      const delay = publishRetryDelayMs(state.publishAttempts, context.config)
      state.retryAt = new Date(context.now().getTime() + delay)
      break
    }
    case 'failed':
      state.retryAt = null
      state.lastError = outcome.reason
      context.log.warn('tracker: the fix PR could not be published', {
        runId: run.id,
        reason: outcome.reason,
      })
      break
  }
  return outcome
}

/** The checks ETags of a head commit and what each answer summarized to. */
const checksEtagSchema = z.object({
  sha: z.string(),
  runs: z.object({ etag: z.string().nullable(), status: z.string() }),
  statuses: z.object({ etag: z.string().nullable(), status: z.string() }),
})
type ChecksEtag = z.infer<typeof checksEtagSchema>

const CHECK_STATUSES: readonly GithubChecksStatus[] = ['passing', 'failing', 'pending', 'none']

function asChecksStatus(value: string): GithubChecksStatus {
  return (CHECK_STATUSES as readonly string[]).includes(value)
    ? (value as GithubChecksStatus)
    : 'pending'
}

/**
 * The checks column keeps both ETags with the status each answer summarized to, as JSON: when
 * one source answers 304 and the other changed, the combined status still needs both.
 */
export function decodeChecksEtag(raw: string | null): ChecksEtag | null {
  if (!raw) return null
  try {
    const parsed = checksEtagSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function pollChecks(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  sha: string,
): Promise<void> {
  const stored = decodeChecksEtag(run.checksEtag)
  const same = stored?.sha === sha ? stored : null
  const target = { owner: repo.owner, name: repo.name, sha }
  const runsRead = await fetchCheckRunsStatus(context.client, target, same?.runs.etag)
  const statusRead = await fetchCombinedStatus(context.client, target, same?.statuses.etag)
  const runsStatus = runsRead.modified ? runsRead.value : asChecksStatus(same?.runs.status ?? '')
  const statusesStatus = statusRead.modified
    ? statusRead.value
    : asChecksStatus(same?.statuses.status ?? '')
  let status = combineChecks(runsStatus, statusesStatus)
  const opened = run.prOpenedAt ?? run.pushedAt
  const fresh =
    opened !== null && context.now().getTime() - opened.getTime() < context.config.checksNoneGraceMs
  // Right after the PR opens nothing has reported yet; `none` only once that had time to happen.
  if (status === 'none' && fresh) status = 'pending'
  apply(context, run, { type: 'checks_updated', status, headSha: sha })
  const etag: ChecksEtag = {
    sha,
    runs: { etag: runsRead.etag, status: runsStatus },
    statuses: { etag: statusRead.etag, status: statusesStatus },
  }
  context.repositories.fixRuns.setEtags(run.id, { checks: JSON.stringify(etag) })
}

/**
 * Applies the PR's state. Returns the run, and false when something is still to come (a merge
 * without its merge commit yet), so the ETag is not stored.
 */
function applyPull(
  context: PollContext,
  run: FixRunRow,
  pr: GithubPull,
  ended: boolean,
): { run: FixRunRow; handled: boolean } {
  let current = run
  if (ended) {
    // A closed unmerged PR that is open again (or was reopened and merged since the last look).
    if (pr.state === 'closed' && !pr.merged) return { run, handled: true }
    current = apply(context, run, { type: 'pr_reopened', number: pr.number })
    if (current.state === run.state) return { run, handled: true }
  }
  if (pr.merged) {
    if (!pr.mergeSha) return { run: current, handled: false }
    return {
      run: apply(context, current, { type: 'pr_merged', mergeSha: pr.mergeSha }),
      handled: true,
    }
  }
  if (pr.state === 'closed')
    return { run: apply(context, current, { type: 'pr_closed' }), handled: true }
  if (pr.draft !== current.prDraft) {
    current = apply(context, current, { type: 'pr_draft_changed', draft: pr.draft })
  }
  return { run: current, handled: true }
}

/** Follows the PR (open, draft, merged, closed, reopened) and then the checks of its head. */
async function pollPull(
  context: PollContext,
  run: FixRunRow,
  repo: RepoRow,
  ended: boolean,
): Promise<void> {
  if (run.prNumber === null) return
  const read = await fetchPull(
    context.client,
    { owner: repo.owner, name: repo.name, number: run.prNumber },
    run.prEtag,
  )
  if (read === null) {
    context.state.lastError = `PR #${run.prNumber} could not be found on ${repo.owner}/${repo.name}.`
    return
  }
  let current = run
  let headSha = run.headSha
  if (read.modified) {
    headSha = read.value.headSha
    const applied = applyPull(context, run, read.value, ended)
    current = applied.run
    context.repositories.fixRuns.setEtags(run.id, { pr: applied.handled ? read.etag : null })
  }
  if (!TRACKED_PR_STATES.includes(current.state) || !headSha) return
  await pollChecks(context, current, repo, headSha)
}

/** One poll of a run in its phase. GitHub errors are thrown for the tracker to record. */
export async function pollFixRun(
  context: PollContext,
  run: FixRunRow,
  phase: TrackingPhase,
): Promise<void> {
  const repo = repoOf(context, run)
  if (!repo) return
  switch (phase) {
    case 'link':
      return linkRun(context, run, repo)
    case 'run':
      return pollWorkflowRun(context, run, repo, false)
    case 'wait':
      checkLost(context, run)
      return
    case 'ended_run':
      return pollWorkflowRun(context, run, repo, true)
    case 'publish':
      await publish(context, run)
      return
    case 'pr':
      return pollPull(context, run, repo, false)
    case 'ended_pr':
      return pollPull(context, run, repo, true)
    case 'deploy':
      return pollDeployments(verifyContextOf(context), run, repo)
    case 'verify':
      return verifyRun(verifyContextOf(context), run, repo)
  }
}

function verifyContextOf(context: PollContext) {
  return {
    ...context,
    retryAt: (at: Date) => {
      context.state.retryAt = at
    },
  }
}
