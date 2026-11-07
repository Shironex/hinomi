import { randomUUID } from 'node:crypto'
import {
  DEFAULT_CALLER_WORKFLOW,
  FixPayloadError,
  currentTime,
  encodeFixDispatch,
  toFixDispatch,
  type EncodedFixDispatch,
  type FixPayloadCompressor,
} from '@hinomi/shared'
import type { RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import {
  GithubError,
  dispatchWorkflow,
  fetchRunnerRepoMeta,
  type GithubSource,
  type RunnerRepoMeta,
} from '../sources/github/index.js'
import { zlibCompressor } from './compressor.js'
import type { RunnerGithub } from './github.js'
import type { FixRunDispatchOutcome, FixRunDispatchRequest, FixRunner } from './runner.js'

// The GitHub Actions runner: builds the dispatch from the plan (checks and links by the repo's
// visibility), records the run as pending, then calls workflow_dispatch on the repo's caller
// workflow with `return_run_details`, so the run id is stored before the API answers.

/** Longest failure reason stored on a run. */
const MAX_REASON = 500

/** The caller workflow file of a repo. */
export function callerWorkflowOf(repo: RepoRow): string {
  return repo.runnerWorkflow ?? DEFAULT_CALLER_WORKFLOW
}

/** The inputs of the workflow_dispatch call, as the caller workflow declares them. */
export function dispatchInputs(
  correlationId: string,
  encoded: Pick<EncodedFixDispatch, 'encoding' | 'payload'>,
): Record<string, string> {
  return { run_id: correlationId, plan: encoded.payload, encoding: encoded.encoding }
}

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}.` : text
}

/** A dispatch failure as a reason a person can act on. */
export function dispatchFailureReason(
  error: unknown,
  target: { fullName: string; workflow: string; ref: string },
): string {
  if (!(error instanceof GithubError)) {
    const detail = error instanceof Error ? error.message : String(error)
    return clip(`The dispatch failed: ${detail}`)
  }
  const detail = error.message
  const where = `${target.fullName}`
  switch (error.kind) {
    case 'not_found':
      return clip(
        `GitHub found no workflow ${target.workflow} on ${target.ref} of ${where}. Add the caller workflow to the default branch (see the runner status for the YAML), or fix the file name in the runner settings.`,
      )
    case 'permission':
      return clip(
        `GitHub refused the dispatch on ${where}: the credential needs Actions: write (GitHub App or fine grained token) or the repo scope (classic token). ${detail}`,
      )
    case 'auth':
      return clip(`GitHub rejected the credential. Check the GitHub source. ${detail}`)
    case 'rate_limit':
      return clip(`GitHub rate limit reached before the dispatch; try again later. ${detail}`)
    case 'network':
    case 'timeout':
      return clip(
        `GitHub could not be reached (${detail}). The workflow may still have started; check the Actions tab of ${where} before dispatching again.`,
      )
    default:
      break
  }
  if (error.status === 422) {
    return clip(
      `GitHub rejected the workflow inputs of ${target.workflow}: the caller workflow must have a workflow_dispatch trigger with the inputs run_id, plan and encoding (see the runner status for the YAML). ${detail}`,
    )
  }
  return clip(`The dispatch failed: ${detail}`)
}

export interface GithubActionsRunnerOptions {
  repositories: Repositories
  /** The GitHub source to dispatch through, opened per dispatch. */
  github: () => RunnerGithub
  compressor?: FixPayloadCompressor
  now?: () => Date
  /** The correlation id sent as `run_id`. Random by default. */
  correlationId?: () => string
}

export class GithubActionsRunner implements FixRunner {
  readonly kind = 'github_actions' as const
  readonly #options: GithubActionsRunnerOptions

  constructor(options: GithubActionsRunnerOptions) {
    this.#options = options
  }

  async dispatch({ repo, plan }: FixRunDispatchRequest): Promise<FixRunDispatchOutcome> {
    const { repositories } = this.#options
    const now = this.#options.now ?? currentTime
    const github = this.#options.github()
    if (!github.ok) return { created: false, code: 'no_source', message: github.message }
    const source: GithubSource = github.source

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

    const correlationId = (this.#options.correlationId ?? randomUUID)()
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
      })
      if (dispatch.steps.length === 0) {
        return {
          created: false,
          code: 'nothing_to_send',
          message: 'The plan has no safe step the runner can apply.',
        }
      }
      encoded = await encodeFixDispatch(dispatch, {
        compressor: this.#options.compressor ?? zlibCompressor,
      })
    } catch (error) {
      if (!(error instanceof FixPayloadError)) throw error
      return { created: false, code: 'plan', message: error.message }
    }

    const { run } = repositories.fixRuns.create(
      {
        repoId: repo.id,
        plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
        runner: this.kind,
        kind: 'fix',
        correlationId,
        checksMode: encoded.dispatch.options.checks,
      },
      now(),
    )
    const result = { encoding: encoded.encoding, omittedStepIds: encoded.omittedStepIds }
    const workflow = callerWorkflowOf(repo)

    try {
      const accepted = await dispatchWorkflow(source.client, {
        owner: meta.owner,
        name: meta.name,
        workflow,
        ref: meta.defaultBranch,
        inputs: dispatchInputs(correlationId, encoded),
      })
      const applied = repositories.fixRuns.applyEvent(
        run.id,
        { type: 'dispatch_accepted', githubRunId: accepted.workflowRunId },
        now(),
      )
      return { created: true, run: applied.ok ? applied.run : run, ...result }
    } catch (error) {
      const reason = dispatchFailureReason(error, {
        fullName: meta.fullName,
        workflow,
        ref: meta.defaultBranch,
      })
      const failed = repositories.fixRuns.applyEvent(run.id, { type: 'failed', reason }, now())
      return { created: true, run: failed.ok ? failed.run : run, ...result }
    }
  }
}
