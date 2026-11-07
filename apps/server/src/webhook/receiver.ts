import {
  GITHUB_WEBHOOK_EVENTS,
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  GITHUB_WEBHOOK_PATH,
  currentTime,
  githubWebhookAckSchema,
  githubWebhookEventSchema,
  type ApiErrorCode,
  type GithubWebhookAck,
  type GithubWebhookEvent,
  type GithubWebhookSettingsDto,
} from '@hinomi/shared'
import type { SecretBox } from '../crypto/secret-box.js'
import type { FixRunRow } from '../db/schema.js'
import { silentLogger, type Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import { readDelivery, type DeliveryTarget } from './events.js'
import { DeliveryLog, readCapped } from './primitives.js'
import { createWebhookSettings, type WebhookSettings } from './settings.js'
import { verifyGithubSignature } from './signature.js'

// The GitHub webhook receiver. It is the one route meant to be reachable from the internet, so
// it trusts nothing about the request until the signature over the raw body verifies, never
// depends on the access checks that protect the rest, answers 404 like an unknown route while it
// is off, and does no more on a delivery than ask the tracker to poll the runs it names.

/** A delivery id is remembered this long; the same id again is a replay and changes nothing. */
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000
/** At most this many delivery ids are remembered; the oldest go first. */
const MAX_REMEMBERED_DELIVERIES = 10_000
/** A rejected request is logged at most this often; every one still updates `lastError`. */
const REJECTION_LOG_EVERY_MS = 60_000
/** GitHub sends a GUID; anything far from one is not a delivery. */
const DELIVERY_ID = /^[0-9a-z-]{8,72}$/i

export interface GithubWebhookReceiverOptions {
  repositories: Repositories
  /** null without HINOMI_SECRET_KEY: no secret can be stored, so the receiver stays off. */
  secretBox: SecretBox | null
  /**
   * Makes the followed runs `select` picks due now (the tracker's `pollNow`, plus waking its
   * timer). Returns the ids of the runs marked.
   */
  pollNow: (select: (run: FixRunRow) => boolean) => number[]
  log?: Logger
  now?: () => Date
  /** HINOMI_WEBHOOK_PORT, shown in the settings. */
  dedicatedPort?: number | null
  replayWindowMs?: number
  maxRememberedDeliveries?: number
}

export interface GithubWebhookReceiver {
  readonly settings: WebhookSettings
  /** Answers one request to the webhook path. Never throws. */
  handle(request: Request): Promise<Response>
  /** The settings with the delivery and error state, for the settings API. */
  view(): GithubWebhookSettingsDto
  /** Resolves once every accepted delivery was handled (tests and shutdown). */
  idle(): Promise<void>
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

function ack(status: GithubWebhookAck['status'], code = 202): Response {
  return json(code, githubWebhookAckSchema.parse({ status }))
}

/** The same answer as any unknown API route, so a closed webhook gives nothing away. */
function notFound(): Response {
  return failure(404, 'not_found', 'No such API route')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The events to tick in GitHub: everything followed, `push` only when it is on. */
export function subscribedEvents(includePush: boolean): GithubWebhookEvent[] {
  return GITHUB_WEBHOOK_EVENTS.filter((event) => includePush || event !== 'push')
}

export function createGithubWebhookReceiver(
  options: GithubWebhookReceiverOptions,
): GithubWebhookReceiver {
  const { repositories } = options
  const log = options.log ?? silentLogger
  const now = options.now ?? currentTime
  const settings = createWebhookSettings(repositories.settings, options.secretBox)
  const deliveries = new DeliveryLog(
    options.replayWindowMs ?? REPLAY_WINDOW_MS,
    options.maxRememberedDeliveries ?? MAX_REMEMBERED_DELIVERIES,
  )
  let lastError: { at: Date; message: string } | null = null
  let lastLoggedRejection = Number.NEGATIVE_INFINITY
  let queue: Promise<void> = Promise.resolve()

  function noteError(message: string, data: Record<string, unknown> = {}): void {
    const at = now()
    lastError = { at, message }
    if (at.getTime() - lastLoggedRejection < REJECTION_LOG_EVERY_MS) return
    lastLoggedRejection = at.getTime()
    log.warn('webhook: a request was rejected or failed', { reason: message, ...data })
  }

  /** Finds the runs the delivery concerns and asks for them to be polled now. */
  function dispatch(event: GithubWebhookEvent, delivery: string, target: DeliveryTarget): void {
    const repo = repositories.repos.getByName(target.owner, target.name)
    if (!repo) {
      log.info('webhook: delivery for a repo Hinomi does not track, ignored', { event, delivery })
      return
    }
    const runIds = options.pollNow(
      (run) => run.repoId === repo.id && target.concerns(run, repo.defaultBranch),
    )
    if (runIds.length > 0) log.info('webhook: polling fix runs now', { event, delivery, runIds })
  }

  async function handle(request: Request): Promise<Response> {
    const state = settings.secret()
    if (!state.ok) {
      if (state.reason === 'undecryptable' || state.reason === 'no_key') {
        noteError('the webhook secret cannot be read: HINOMI_SECRET_KEY changed or is not set')
      }
      return notFound()
    }

    const declared = Number(request.headers.get('content-length') ?? '0')
    const tooLarge = `The body is larger than ${GITHUB_WEBHOOK_MAX_BODY_BYTES} bytes`
    if (declared > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      noteError('a delivery was rejected: the body is too large')
      return failure(413, 'payload_too_large', tooLarge)
    }
    const body = await readCapped(request, GITHUB_WEBHOOK_MAX_BODY_BYTES)
    if (!body) {
      noteError('a delivery was rejected: the body is too large')
      return failure(413, 'payload_too_large', tooLarge)
    }

    // Nothing about the request is believed before this check, and its answer says nothing.
    if (
      !verifyGithubSignature(
        state.secret,
        body,
        request.headers.get('x-hub-signature-256') ?? undefined,
      )
    ) {
      noteError('a request was rejected: missing or invalid signature')
      return new Response(null, { status: 401 })
    }

    const eventHeader = request.headers.get('x-github-event')?.trim() ?? ''
    const delivery = request.headers.get('x-github-delivery')?.trim() ?? ''
    if (eventHeader === '' || !DELIVERY_ID.test(delivery)) {
      noteError(
        'a delivery was rejected: the X-GitHub-Event or X-GitHub-Delivery header is missing',
      )
      return failure(400, 'bad_request', 'Missing X-GitHub-Event or X-GitHub-Delivery')
    }
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
      noteError('a delivery was rejected: the content type is not application/json')
      return failure(
        415,
        'unsupported_media_type',
        'Set the webhook content type to application/json',
      )
    }
    const at = now()
    if (deliveries.replayed(delivery, at.getTime())) return ack('duplicate', 200)

    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'))
    } catch {
      noteError('a delivery was rejected: the body is not valid JSON', { delivery })
      return failure(400, 'invalid_json', 'The body is not valid JSON')
    }
    settings.recordDelivery(eventHeader.slice(0, 64), at)

    const event = githubWebhookEventSchema.safeParse(eventHeader)
    if (!event.success) return ack('ignored')
    const read = readDelivery(event.data, payload, { includePush: state.includePush })
    if (read.kind === 'ignored') return ack(event.data === 'ping' ? 'accepted' : 'ignored')
    if (read.kind === 'malformed') {
      noteError(`a delivery was ignored: ${read.message}`, { event: event.data, delivery })
      return ack('ignored')
    }

    const { target } = read
    // Answer GitHub first; finding the runs is a few local queries.
    queue = queue.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            try {
              dispatch(event.data, delivery, target)
            } catch (error) {
              noteError(`handling a delivery failed: ${errorText(error)}`, { delivery })
            }
            resolve()
          })
        }),
    )
    return ack('accepted')
  }

  return {
    settings,

    async handle(request) {
      try {
        return await handle(request)
      } catch (error) {
        noteError(`handling a request failed: ${errorText(error)}`)
        return failure(500, 'internal', 'Something went wrong on the server')
      }
    },

    view() {
      const config = settings.read()
      const delivered = settings.lastDelivery()
      return {
        enabled: config.enabled,
        secretSet: config.secretSet,
        secretCreatedAt: config.secretCreatedAt?.toISOString() ?? null,
        canStoreSecret: settings.canStoreSecret,
        includePush: config.includePush,
        path: GITHUB_WEBHOOK_PATH,
        dedicatedPort: options.dedicatedPort ?? null,
        events: subscribedEvents(config.includePush),
        lastDeliveryAt: delivered?.at.toISOString() ?? null,
        lastDeliveryEvent: delivered?.event ?? null,
        lastErrorAt: lastError?.at.toISOString() ?? null,
        lastError: lastError?.message ?? null,
      }
    },

    idle: () => queue,
  }
}
