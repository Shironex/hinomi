import {
  FIX_RUN_BRANCHES,
  WEBHOOK_DISPATCH_SCHEMA,
  currentTime,
  type FixPayloadCompressor,
  type WebhookDispatchBody,
} from '@hinomi/shared'
import type { Repositories } from '../repository/index.js'
import { finishDispatch, isRefusal, prepareDispatch } from './dispatch.js'
import type { RunnerGithubFor } from './github.js'
import type { FixRunDispatchOutcome, FixRunDispatchRequest, FixRunner } from './runner.js'

// The webhook runner: the same prepared dispatch as GitHub Actions, posted as a signed JSON body
// to the URL in the settings. The external runner applies it, pushes the fix branch and reports
// back on the callback path (webhook-callback.ts); Hinomi then opens the PR itself.

/** Posts the plan; built in the webhook folder (signing, the address guard) and handed in. */
export interface WebhookDelivery {
  /** Why nothing can be posted, or null when the webhook runner is set up. */
  problem(): string | null
  deliver(
    payload: Omit<WebhookDispatchBody, 'callbackUrl'>,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
}

export interface WebhookRunnerOptions {
  repositories: Repositories
  github: RunnerGithubFor
  delivery: WebhookDelivery
  compressor?: FixPayloadCompressor
  now?: () => Date
  correlationId?: () => string
}

export class WebhookRunner implements FixRunner {
  readonly kind = 'webhook' as const
  readonly #options: WebhookRunnerOptions

  constructor(options: WebhookRunnerOptions) {
    this.#options = options
  }

  async dispatch(request: FixRunDispatchRequest): Promise<FixRunDispatchOutcome> {
    const { repositories, delivery } = this.#options
    const now = this.#options.now ?? currentTime
    // Refused before a run exists, so an unconfigured runner leaves no failed rows behind.
    const problem = delivery.problem()
    if (problem) return { created: false, code: 'not_configured', message: problem }
    const prepared = await prepareDispatch(this.#options, this.kind, request)
    if (isRefusal(prepared)) return prepared
    const kind = request.kind ?? 'fix'
    const outcome = await delivery.deliver({
      schema: WEBHOOK_DISPATCH_SCHEMA,
      runId: prepared.correlationId,
      kind,
      repo: prepared.meta.fullName,
      branch: FIX_RUN_BRANCHES[kind],
      encoding: prepared.encoded.encoding,
      plan: prepared.encoded.payload,
    })
    return finishDispatch(
      repositories,
      prepared,
      outcome.ok ? { accepted: true } : { accepted: false, reason: outcome.reason },
      now(),
    )
  }
}
