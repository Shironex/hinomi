import { z } from 'zod'
import { fixRunKindSchema } from './fix-runs.js'
import { FIX_DISPATCH_ENCODINGS } from './runner-payload.js'

// The webhook runner: Hinomi posts a fix plan to a URL the user configured, an external runner
// applies it, pushes the fix branch and reports back on the callback path. Both directions are
// signed with one shared secret (docs/runners.md, docs/design/fix-runner.md section 21).

/** Where an external runner reports back, on the main port and on the webhook only port. */
export const RUNNER_CALLBACK_PATH = '/api/runner/callback'

/** Largest callback body Hinomi reads. A result with every check tail fits well inside. */
export const RUNNER_CALLBACK_MAX_BODY_BYTES = 1024 * 1024

/** Headers of a signed delivery in either direction. */
export const RUNNER_SIGNATURE_HEADER = 'x-hinomi-signature'
export const RUNNER_DELIVERY_HEADER = 'x-hinomi-delivery'
export const RUNNER_EVENT_HEADER = 'x-hinomi-event'

/** A signature older or newer than this many seconds is refused. */
export const RUNNER_SIGNATURE_TOLERANCE_SECONDS = 300

export const WEBHOOK_DISPATCH_SCHEMA = 'hinomi.webhook-dispatch/1'

/**
 * The body Hinomi posts to the webhook runner. `plan` and `encoding` are exactly the workflow
 * inputs the GitHub Actions runner sends, so an external runner can pass them to the fix runner
 * action unchanged.
 */
export const webhookDispatchBodySchema = z.object({
  schema: z.literal(WEBHOOK_DISPATCH_SCHEMA),
  /** The correlation id; the callback names the run with it. */
  runId: z.string().min(1),
  kind: fixRunKindSchema,
  /** `owner/name` as GitHub spells it. */
  repo: z.string(),
  /** The branch the external runner pushes (`hinomi/fix-plan` or `hinomi/majors`). */
  branch: z.string(),
  encoding: z.enum(FIX_DISPATCH_ENCODINGS),
  plan: z.string(),
  /** Where to report back, when the settings name it. */
  callbackUrl: z.string().nullable(),
})
export type WebhookDispatchBody = z.infer<typeof webhookDispatchBodySchema>

export const RUNNER_CALLBACK_SCHEMA = 'hinomi.runner-callback/1'

/** What an external runner reports about a run. */
export const RUNNER_CALLBACK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export const runnerCallbackStatusSchema = z.enum(RUNNER_CALLBACK_STATUSES)
export type RunnerCallbackStatus = z.infer<typeof runnerCallbackStatusSchema>

/**
 * The callback body. `result` is checked against the strict fix result schema by the server, so
 * it stays `unknown` here and an invalid result gets its own error message.
 */
export const runnerCallbackSchema = z.strictObject({
  schema: z.literal(RUNNER_CALLBACK_SCHEMA),
  runId: z.string().min(1).max(100),
  status: runnerCallbackStatusSchema,
  /** The fix result, required for `completed`. */
  result: z.unknown().optional(),
  /** Head of the pushed fix branch, required for `completed` with a patch. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** Why the run failed, shown as is (cut to 500 characters, control characters removed). */
  reason: z.string().max(10_000).optional(),
})
export type RunnerCallback = z.infer<typeof runnerCallbackSchema>

/**
 * The answer to a callback whose signature verified: `applied` changed the run, `unchanged`
 * repeated what it already recorded, `duplicate` is a delivery id seen before.
 */
export const runnerCallbackAckSchema = z.object({
  status: z.enum(['applied', 'unchanged', 'duplicate']),
  /** The run's state after the callback. Absent for a duplicate. */
  state: z.string().optional(),
})
export type RunnerCallbackAck = z.infer<typeof runnerCallbackAckSchema>

const isoDate = z.iso.datetime({ offset: true })

// ---------------------------------------------------------------------------
// Settings: GET and PATCH /api/settings/webhook-runner, POST .../secret

export const webhookRunnerSettingsSchema = z.object({
  /** A URL and a readable secret are set, so repos with the webhook kind can dispatch. */
  configured: z.boolean(),
  url: z.string().nullable(),
  /** Allows plain http and private addresses, for a runner on the same network. */
  allowPrivate: z.boolean(),
  /** Sent with every dispatch so the external runner knows where to report back. */
  callbackUrl: z.string().nullable(),
  /** A secret was generated. It is never returned after the rotation that made it. */
  secretSet: z.boolean(),
  secretCreatedAt: isoDate.nullable(),
  /** False without HINOMI_SECRET_KEY: the secret is stored encrypted, so none can be generated. */
  canStoreSecret: z.boolean(),
  /** The callback path to expose (alone), on the main port and on `dedicatedPort`. */
  callbackPath: z.string(),
  /** HINOMI_WEBHOOK_PORT, the listener that serves only the webhook paths. Null when not set. */
  dedicatedPort: z.number().int().nullable(),
  /** The last callback whose signature verified. */
  lastCallbackAt: isoDate.nullable(),
  /** The last rejected callback since the server started. */
  lastErrorAt: isoDate.nullable(),
  lastError: z.string().nullable(),
  /** One line on what is missing, or that the webhook runner is ready. */
  message: z.string(),
})
export type WebhookRunnerSettingsDto = z.infer<typeof webhookRunnerSettingsSchema>

/** PATCH body. `url: null` or `callbackUrl: null` clears it. */
export const updateWebhookRunnerRequestSchema = z
  .strictObject({
    url: z.url().max(2000).nullable().optional(),
    allowPrivate: z.boolean().optional(),
    callbackUrl: z.url().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateWebhookRunnerRequest = z.infer<typeof updateWebhookRunnerRequestSchema>

/** The answer to a rotation: the only time the secret is shown. */
export const rotateWebhookRunnerSecretResponseSchema = z.object({
  secret: z.string(),
  settings: webhookRunnerSettingsSchema,
})
export type RotateWebhookRunnerSecretResponse = z.infer<
  typeof rotateWebhookRunnerSecretResponseSchema
>
