import { z } from 'zod'
import { SecretKeyMissingError, type SecretBox } from '../crypto/secret-box.js'
import type { SettingsRepository } from '../repository/index.js'
import { generateWebhookSecret } from './signature.js'

// The webhook runner's stored settings: where Hinomi posts plans, whether private addresses
// are allowed, the callback URL it announces, and the shared secret, kept encrypted with
// HINOMI_SECRET_KEY and readable in clear text only in the answer to the rotation that made it.

export const WEBHOOK_RUNNER_SETTING_KEYS = {
  /** `{ url, allowPrivate, callbackUrl, secret, secretCreatedAt }`, the secret encrypted. */
  config: 'runner.webhook',
  /** `{ at }` of the last callback whose signature verified. */
  lastCallback: 'runner.webhookLastCallback',
} as const

const storedSchema = z.object({
  url: z.string().nullable().default(null),
  allowPrivate: z.boolean().default(false),
  callbackUrl: z.string().nullable().default(null),
  secret: z.string().nullable().default(null),
  secretCreatedAt: z.iso.datetime({ offset: true }).nullable().default(null),
})
type Stored = z.infer<typeof storedSchema>

const lastCallbackSchema = z.object({ at: z.iso.datetime({ offset: true }) })

export interface WebhookRunnerConfig {
  url: string | null
  allowPrivate: boolean
  callbackUrl: string | null
  secretSet: boolean
  secretCreatedAt: Date | null
}

/** The secret, when one is stored and can be decrypted. */
export type WebhookRunnerSecret =
  { ok: true; secret: string } | { ok: false; reason: 'no_secret' | 'no_key' | 'undecryptable' }

export type WebhookRunnerSettings = ReturnType<typeof createWebhookRunnerSettings>

/** Why the stored secret cannot be used, as a sentence. */
export function secretProblem(reason: 'no_secret' | 'no_key' | 'undecryptable'): string {
  switch (reason) {
    case 'no_secret':
      return 'Generate the webhook runner secret first.'
    case 'no_key':
      return 'HINOMI_SECRET_KEY is not set, so the webhook runner secret cannot be read.'
    case 'undecryptable':
      return 'The webhook runner secret cannot be decrypted (HINOMI_SECRET_KEY changed). Generate a new one.'
  }
}

export function createWebhookRunnerSettings(
  settings: SettingsRepository,
  secretBox: SecretBox | null,
) {
  function stored(): Stored {
    return settings.get(WEBHOOK_RUNNER_SETTING_KEYS.config, storedSchema) ?? storedSchema.parse({})
  }

  return {
    /** Whether a secret can be generated (HINOMI_SECRET_KEY is set). */
    canStoreSecret: secretBox !== null,

    read(): WebhookRunnerConfig {
      const value = stored()
      return {
        url: value.url,
        allowPrivate: value.allowPrivate,
        callbackUrl: value.callbackUrl,
        secretSet: value.secret !== null,
        secretCreatedAt: value.secretCreatedAt ? new Date(value.secretCreatedAt) : null,
      }
    },

    secret(): WebhookRunnerSecret {
      const value = stored()
      if (value.secret === null) return { ok: false, reason: 'no_secret' }
      if (!secretBox) return { ok: false, reason: 'no_key' }
      try {
        return { ok: true, secret: secretBox.decrypt(value.secret) }
      } catch {
        return { ok: false, reason: 'undecryptable' }
      }
    },

    /**
     * Replaces the secret with a new random one and returns it: the only time it is readable.
     * Callbacks signed with the old secret fail from now on. Throws without HINOMI_SECRET_KEY.
     */
    rotate(now: Date): string {
      if (!secretBox) throw new SecretKeyMissingError()
      const secret = generateWebhookSecret()
      settings.set(WEBHOOK_RUNNER_SETTING_KEYS.config, {
        ...stored(),
        secret: secretBox.encrypt(secret),
        secretCreatedAt: now.toISOString(),
      })
      return secret
    },

    /** Stores the fields given and keeps the rest. URLs are checked by the caller. */
    update(patch: { url?: string | null; allowPrivate?: boolean; callbackUrl?: string | null }) {
      const value = stored()
      settings.set(WEBHOOK_RUNNER_SETTING_KEYS.config, {
        ...value,
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.allowPrivate !== undefined && { allowPrivate: patch.allowPrivate }),
        ...(patch.callbackUrl !== undefined && { callbackUrl: patch.callbackUrl }),
      })
    },

    recordCallback(at: Date): void {
      settings.set(WEBHOOK_RUNNER_SETTING_KEYS.lastCallback, { at: at.toISOString() })
    },

    lastCallback(): Date | null {
      const value = settings.get(WEBHOOK_RUNNER_SETTING_KEYS.lastCallback, lastCallbackSchema)
      return value ? new Date(value.at) : null
    },
  }
}
