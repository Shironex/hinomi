import { randomUUID } from 'node:crypto'
import {
  FixPayloadError,
  currentTime,
  encodeFixDispatch,
  toFixDispatch,
  type EncodedFixDispatch,
  type FixPayloadCompressor,
  type FixRunnerKind,
} from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import {
  fetchRunnerRepoMeta,
  type GithubSource,
  type RunnerRepoMeta,
} from '../sources/github/index.js'
import { zlibCompressor } from './compressor.js'
import type { RunnerGithub } from './github.js'
import type {
  FixRunDispatchCreated,
  FixRunDispatchRefusal,
  FixRunDispatchRequest,
} from './runner.js'

// What every runner does before it hands a plan over: read the repo on GitHub (visibility,
// default branch, GitHub's spelling of the name), project the plan to the dispatch (checks and
// links by visibility; for a majors run only the major upgrades), encode it within the payload
// budget and record the run as pending. The runner then delivers the payload its own way.

/** Longest failure reason stored on a run. */
export const MAX_REASON = 500

/** A reason cut to what a run stores. */
export function clipReason(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}.` : text
}

export interface PrepareDispatchOptions {
  repositories: Repositories
  /** The GitHub source to read the repo through, opened per dispatch. */
  github: () => RunnerGithub
  compressor?: FixPayloadCompressor
  now?: () => Date
  /** The correlation id. Random by default. */
  correlationId?: () => string
}

/** A pending run with its encoded payload, ready to hand over. */
export interface PreparedDispatch {
  run: FixRunRow
  source: GithubSource
  meta: RunnerRepoMeta
  correlationId: string
  encoded: EncodedFixDispatch
}

/** Builds the dispatch and records the pending run, or says why no run was created. */
export async function prepareDispatch(
  options: PrepareDispatchOptions,
  runner: FixRunnerKind,
  { repo, plan, kind = 'fix' }: FixRunDispatchRequest,
): Promise<PreparedDispatch | FixRunDispatchRefusal> {
  const now = options.now ?? currentTime
  const github = options.github()
  if (!github.ok) return { created: false, code: 'no_source', message: github.message }
  const source = github.source

  let meta: RunnerRepoMeta
  try {
    meta = await fetchRunnerRepoMeta(source.client, repo.owner, repo.name)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      created: false,
      code: 'unavailable',
      message: `GitHub could not be asked about ${repo.owner}/${repo.name}: ${detail}`,
    }
  }

  const correlationId = (options.correlationId ?? randomUUID)()
  let encoded: EncodedFixDispatch
  try {
    // GitHub's spelling of the repo: the runner compares it with github.repository.
    const fixPlan = {
      ...plan.plan,
      repo: { ...plan.plan.repo, owner: meta.owner, name: meta.name, fullName: meta.fullName },
    }
    const dispatch = toFixDispatch(fixPlan, {
      runId: correlationId,
      baseBranch: meta.defaultBranch,
      visibility: meta.visibility,
      now: now(),
      kind,
    })
    if (kind === 'majors' && dispatch.risky.length === 0) {
      return {
        created: false,
        code: 'nothing_to_send',
        message: 'The plan has no major upgrade the agent can take.',
      }
    }
    if (kind === 'fix' && dispatch.steps.length === 0) {
      return {
        created: false,
        code: 'nothing_to_send',
        message: 'The plan has no safe step the runner can apply.',
      }
    }
    encoded = await encodeFixDispatch(dispatch, {
      compressor: options.compressor ?? zlibCompressor,
    })
  } catch (error) {
    if (!(error instanceof FixPayloadError)) throw error
    return { created: false, code: 'plan', message: error.message }
  }

  const { run } = options.repositories.fixRuns.create(
    {
      repoId: repo.id,
      plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
      runner,
      kind,
      correlationId,
      checksMode: encoded.dispatch.options.checks,
    },
    now(),
  )
  return { run, source, meta, correlationId, encoded }
}

/** True when prepareDispatch refused before creating a run. */
export function isRefusal(
  value: PreparedDispatch | FixRunDispatchRefusal,
): value is FixRunDispatchRefusal {
  return 'created' in value
}

/**
 * Ends the hand over: `dispatched` (with the GitHub run id when there is one) or `failed` with
 * the reason. Returns the outcome the API answers.
 */
export function finishDispatch(
  repositories: Repositories,
  prepared: PreparedDispatch,
  outcome: { accepted: true; githubRunId?: number | null } | { accepted: false; reason: string },
  at: Date,
): FixRunDispatchCreated {
  const { run, encoded } = prepared
  const applied = outcome.accepted
    ? repositories.fixRuns.applyEvent(
        run.id,
        { type: 'dispatch_accepted', githubRunId: outcome.githubRunId ?? null },
        at,
      )
    : repositories.fixRuns.applyEvent(
        run.id,
        { type: 'failed', reason: clipReason(outcome.reason) },
        at,
      )
  return {
    created: true,
    run: applied.ok ? applied.run : run,
    encoding: encoded.encoding,
    omittedStepIds: encoded.omittedStepIds,
  }
}
