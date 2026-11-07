import { z } from 'zod'

// The optional GitHub webhook: settings, the secret rotation answer and what the receiver
// answers GitHub. A delivery only asks the fix run tracker to poll the runs it names sooner;
// polling stays the source of truth (docs/github-webhook.md).

/** Where GitHub posts deliveries, on the main port and on the optional webhook port. */
export const GITHUB_WEBHOOK_PATH = '/api/github/webhook'

/** Events the receiver handles. `push` only when `includePush` is on. Anything else is ignored. */
export const GITHUB_WEBHOOK_EVENTS = [
  'workflow_run',
  'pull_request',
  'check_suite',
  'check_run',
  'status',
  'push',
  'ping',
] as const
export const githubWebhookEventSchema = z.enum(GITHUB_WEBHOOK_EVENTS)
export type GithubWebhookEvent = z.infer<typeof githubWebhookEventSchema>

/** Largest delivery body the receiver reads. Fix run events are a few tens of KiB. */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

const isoDate = z.iso.datetime({ offset: true })

export const githubWebhookSettingsSchema = z.object({
  /** Off by default. While off the receiver answers 404 like any unknown route. */
  enabled: z.boolean(),
  /** A secret was generated. It is never returned after the rotation that created it. */
  secretSet: z.boolean(),
  secretCreatedAt: isoDate.nullable(),
  /** False without HINOMI_SECRET_KEY: the secret is stored encrypted, so none can be generated. */
  canStoreSecret: z.boolean(),
  /** Pushes to the fix branch and the default branch also ask for a poll. */
  includePush: z.boolean(),
  /** The path to give GitHub (and to expose, alone). */
  path: z.string(),
  /** HINOMI_WEBHOOK_PORT: a listener that serves only the webhook path. Null when not set. */
  dedicatedPort: z.number().int().nullable(),
  /** The events to tick in GitHub for the current settings. */
  events: z.array(githubWebhookEventSchema),
  /** The last delivery whose signature verified. */
  lastDeliveryAt: isoDate.nullable(),
  lastDeliveryEvent: z.string().nullable(),
  /** The last rejected request or failed delivery since the server started. */
  lastErrorAt: isoDate.nullable(),
  lastError: z.string().nullable(),
})
export type GithubWebhookSettingsDto = z.infer<typeof githubWebhookSettingsSchema>

export const updateGithubWebhookRequestSchema = z
  .strictObject({ enabled: z.boolean().optional(), includePush: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateGithubWebhookRequest = z.infer<typeof updateGithubWebhookRequestSchema>

/** The answer to a rotation: the only time the secret is shown. */
export const rotateGithubWebhookSecretResponseSchema = z.object({
  secret: z.string(),
  settings: githubWebhookSettingsSchema,
})
export type RotateGithubWebhookSecretResponse = z.infer<
  typeof rotateGithubWebhookSecretResponseSchema
>

/** What the receiver answers a delivery whose signature verified. */
export const githubWebhookAckSchema = z.object({
  /** `ignored`: an event or repo Hinomi does not follow. `duplicate`: a delivery id seen before. */
  status: z.enum(['accepted', 'ignored', 'duplicate']),
})
export type GithubWebhookAck = z.infer<typeof githubWebhookAckSchema>
