import {
  DEFAULT_CALLER_WORKFLOW,
  currentTime,
  type EncodedFixDispatch,
  type FixPayloadCompressor,
} from '@hinomi/shared'
import type { RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { GithubError, dispatchWorkflow } from '../sources/github/index.js'
import { clipReason as clip, finishDispatch, isRefusal, prepareDispatch } from './dispatch.js'
import type { RunnerGithubFor } from './github.js'
import type { FixRunDispatchOutcome, FixRunDispatchRequest, FixRunner } from './runner.js'

// The GitHub Actions runner: builds the dispatch from the plan (checks and links by the repo's
// visibility; for a majors run only the major upgrades, with the agent on), records the run as
// pending, then calls workflow_dispatch on the repo's caller
// workflow with `return_run_details`, so the run id is stored before the API answers.

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
  github: RunnerGithubFor
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

  async dispatch(request: FixRunDispatchRequest): Promise<FixRunDispatchOutcome> {
    const { repositories } = this.#options
    const now = this.#options.now ?? currentTime
    const prepared = await prepareDispatch(this.#options, this.kind, request)
    if (isRefusal(prepared)) return prepared
    const { meta, source, correlationId, encoded } = prepared
    const workflow = callerWorkflowOf(request.repo)

    try {
      const accepted = await dispatchWorkflow(source.client, {
        owner: meta.owner,
        name: meta.name,
        workflow,
        ref: meta.defaultBranch,
        inputs: dispatchInputs(correlationId, encoded),
      })
      return finishDispatch(
        repositories,
        prepared,
        { accepted: true, githubRunId: accepted.workflowRunId },
        now(),
      )
    } catch (error) {
      const reason = dispatchFailureReason(error, {
        fullName: meta.fullName,
        workflow,
        ref: meta.defaultBranch,
      })
      return finishDispatch(repositories, prepared, { accepted: false, reason }, now())
    }
  }
}
