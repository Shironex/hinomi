import {
  RUNNER_CALLBACK_MAX_BODY_BYTES,
  RUNNER_CALLBACK_PATH,
  RUNNER_DELIVERY_HEADER,
  RUNNER_SIGNATURE_HEADER,
  RUNNER_SIGNATURE_TOLERANCE_SECONDS,
  currentTime,
  runnerCallbackAckSchema,
  runnerCallbackSchema,
  type ApiErrorCode,
  type RunnerCallback,
  type RunnerCallbackAck,
  type WebhookRunnerSettingsDto,
} from '@hinomi/shared'
import type { SecretBox } from '../crypto/secret-box.js'
import { silentLogger, type Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import { DeliveryLog, readCapped } from './primitives.js'
import { checkRunnerUrl } from './ssrf.js'
import {
  createWebhookRunnerSettings,
  secretProblem,
  type WebhookRunnerSettings,
} from './runner-settings.js'
import { verifyRunnerSignature } from './signature.js'

// The webhook runner's callback receiver. Like the GitHub webhook it is meant to be reachable
// from outside, so nothing about a request is believed before the signature over the timestamp
// and the raw body verifies; it answers 404 like an unknown route while no secret can be read,
// keeps delivery ids for replay protection and caps the body. What a verified callback means
// for the run is decided in the runner folder (handleRunnerCallback), handed in here.

const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_REMEMBERED_DELIVERIES = 10_000
const REJECTION_LOG_EVERY_MS = 60_000
const DELIVERY_ID = /^[0-9a-z-]{8,72}$/i

/** What handling a verified callback did, as the runner folder reports it. */
export type CallbackHandling = CallbackApplied | CallbackRefused
export interface CallbackApplied {
  kind: 'applied' | 'unchanged'
  state: string
}
export interface CallbackRefused {
  kind: 'not_found' | 'invalid' | 'conflict' | 'unavailable'
  message: string
}

function wasApplied(handling: CallbackHandling): handling is CallbackApplied {
  return handling.kind === 'applied' || handling.kind === 'unchanged'
}

export interface RunnerCallbackReceiverOptions {
  repositories: Repositories
  secretBox: SecretBox | null
  /** Applies a verified callback to its run (handleRunnerCallback). */
  handle: (callback: RunnerCallback) => Promise<CallbackHandling>
  log?: Logger
  now?: () => Date
  dedicatedPort?: number | null
}

export interface RunnerCallbackReceiver {
  readonly settings: WebhookRunnerSettings
  /** Answers one request to the callback path. Never throws. */
  handle(request: Request): Promise<Response>
  /** The settings with the callback and error state, for the settings API. */
  view(): WebhookRunnerSettingsDto
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function failure(status: number, code: ApiErrorCode, message: string): Response {
  return json(status, { error: { code, message } })
}

function ack(body: RunnerCallbackAck): Response {
  return json(200, runnerCallbackAckSchema.parse(body))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const HANDLING_STATUS = {
  not_found: [404, 'not_found'],
  invalid: [422, 'validation_failed'],
  conflict: [409, 'conflict'],
  unavailable: [503, 'unavailable'],
} as const satisfies Record<string, readonly [number, ApiErrorCode]>

export function createRunnerCallbackReceiver(
  options: RunnerCallbackReceiverOptions,
): RunnerCallbackReceiver {
  const log = options.log ?? silentLogger
  const now = options.now ?? currentTime
  const settings = createWebhookRunnerSettings(options.repositories.settings, options.secretBox)
  const deliveries = new DeliveryLog(REPLAY_WINDOW_MS, MAX_REMEMBERED_DELIVERIES)
  let lastError: { at: Date; message: string } | null = null
  let lastLoggedRejection = Number.NEGATIVE_INFINITY

  function noteError(message: string, data: Record<string, unknown> = {}): void {
    const at = now()
    lastError = { at, message }
    if (at.getTime() - lastLoggedRejection < REJECTION_LOG_EVERY_MS) return
    lastLoggedRejection = at.getTime()
    log.warn('runner callback: a request was rejected or failed', { reason: message, ...data })
  }

  async function handle(request: Request): Promise<Response> {
    const secret = settings.secret()
    if (!secret.ok) {
      if (secret.reason !== 'no_secret') noteError(secretProblem(secret.reason))
      return failure(404, 'not_found', 'No such API route')
    }
    const tooLarge = `The body is larger than ${RUNNER_CALLBACK_MAX_BODY_BYTES} bytes`
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > RUNNER_CALLBACK_MAX_BODY_BYTES) {
      noteError('a callback was rejected: the body is too large')
      return failure(413, 'payload_too_large', tooLarge)
    }
    const body = await readCapped(request, RUNNER_CALLBACK_MAX_BODY_BYTES)
    if (!body) {
      noteError('a callback was rejected: the body is too large')
      return failure(413, 'payload_too_large', tooLarge)
    }

    const at = now()
    const checked = verifyRunnerSignature(
      secret.secret,
      body,
      request.headers.get(RUNNER_SIGNATURE_HEADER) ?? undefined,
      at,
      RUNNER_SIGNATURE_TOLERANCE_SECONDS,
    )
    if (!checked.ok) {
      noteError(
        checked.reason === 'expired'
          ? 'a callback was rejected: its signature timestamp is more than 5 minutes off'
          : 'a callback was rejected: missing or invalid signature',
      )
      return new Response(null, { status: 401 })
    }

    const delivery = request.headers.get(RUNNER_DELIVERY_HEADER)?.trim() ?? ''
    if (!DELIVERY_ID.test(delivery)) {
      noteError('a callback was rejected: the X-Hinomi-Delivery header is missing')
      return failure(400, 'bad_request', 'Missing or malformed X-Hinomi-Delivery')
    }
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
      return failure(415, 'unsupported_media_type', 'Send the callback as application/json')
    }
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'))
    } catch {
      noteError('a callback was rejected: the body is not valid JSON', { delivery })
      return failure(400, 'invalid_json', 'The body is not valid JSON')
    }
    const parsed = runnerCallbackSchema.safeParse(payload)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const message = `The callback is malformed${issue ? ` at ${issue.path.join('.') || 'the top'}: ${issue.message}` : ''}`
      noteError(message, { delivery })
      return failure(422, 'validation_failed', message)
    }
    if (deliveries.replayed(delivery, at.getTime())) return ack({ status: 'duplicate' })
    settings.recordCallback(at)

    const handled = await options.handle(parsed.data)
    if (wasApplied(handled)) {
      log.info('runner callback: applied', {
        delivery,
        runId: parsed.data.runId,
        status: parsed.data.status,
        outcome: handled.kind,
        state: handled.state,
      })
      return ack({ status: handled.kind, state: handled.state })
    }
    // A retry of a refused callback must not be taken for a replay.
    deliveries.forget(delivery)
    noteError(`a callback was refused: ${handled.message}`, { delivery })
    const [status, code] = HANDLING_STATUS[handled.kind]
    return failure(status, code, handled.message)
  }

  return {
    settings,

    async handle(request) {
      try {
        return await handle(request)
      } catch (error) {
        noteError(`handling a callback failed: ${errorText(error)}`)
        return failure(500, 'internal', 'Something went wrong on the server')
      }
    },

    view() {
      const config = settings.read()
      const secret = settings.secret()
      const urlCheck = config.url ? checkRunnerUrl(config.url, config.allowPrivate) : null
      const problem = !config.url
        ? 'Set the webhook runner URL.'
        : urlCheck && !urlCheck.ok
          ? urlCheck.message
          : !secret.ok
            ? secretProblem(secret.reason)
            : null
      return {
        configured: problem === null,
        url: config.url,
        allowPrivate: config.allowPrivate,
        callbackUrl: config.callbackUrl,
        secretSet: config.secretSet,
        secretCreatedAt: config.secretCreatedAt?.toISOString() ?? null,
        canStoreSecret: settings.canStoreSecret,
        callbackPath: RUNNER_CALLBACK_PATH,
        dedicatedPort: options.dedicatedPort ?? null,
        lastCallbackAt: settings.lastCallback()?.toISOString() ?? null,
        lastErrorAt: lastError?.at.toISOString() ?? null,
        lastError: lastError?.message ?? null,
        message: problem ?? 'Ready. Repos with the webhook runner kind post their plans here.',
      }
    },
  }
}
