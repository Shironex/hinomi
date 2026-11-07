import { z } from 'zod'
import { SecretKeyMissingError, type SecretBox } from '../crypto/secret-box.js'
import type { SettingsRepository } from '../repository/index.js'
import { generateWebhookSecret } from './signature.js'

// The webhook's stored settings. The secret is kept encrypted with HINOMI_SECRET_KEY (the same
// box and format as source tokens) and is never stored, logged or returned in clear text after
// the rotation that made it.

export const WEBHOOK_SETTING_KEYS = {
  /** `{ enabled, secret, secretCreatedAt, includePush }`, the secret encrypted. */
  config: 'github.webhook',
  /** `{ at, event }` of the last delivery whose signature verified. */
  lastDelivery: 'github.webhookLastDelivery',
} as const

const storedSchema = z.object({
  enabled: z.boolean().default(false),
  secret: z.string().nullable().default(null),
  secretCreatedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  includePush: z.boolean().default(false),
})
type Stored = z.infer<typeof storedSchema>

const lastDeliverySchema = z.object({
  at: z.iso.datetime({ offset: true }),
  event: z.string(),
})

export interface WebhookConfig {
  enabled: boolean
  secretSet: boolean
  secretCreatedAt: Date | null
  includePush: boolean
}

/** Why the receiver cannot check a delivery; it then answers 404 like an unknown route. */
export type WebhookSecretState =
  | { ok: true; secret: string; includePush: boolean }
  | { ok: false; reason: 'disabled' | 'no_secret' | 'no_key' | 'undecryptable' }

export type WebhookSettings = ReturnType<typeof createWebhookSettings>

export function createWebhookSettings(settings: SettingsRepository, secretBox: SecretBox | null) {
  function stored(): Stored {
    return settings.get(WEBHOOK_SETTING_KEYS.config, storedSchema) ?? storedSchema.parse({})
  }

  return {
    /** Whether a secret can be generated (HINOMI_SECRET_KEY is set). */
    canStoreSecret: secretBox !== null,

    read(): WebhookConfig {
      const value = stored()
      return {
        enabled: value.enabled,
        secretSet: value.secret !== null,
        secretCreatedAt: value.secretCreatedAt ? new Date(value.secretCreatedAt) : null,
        includePush: value.includePush,
      }
    },

    /** The secret deliveries are checked with, when the webhook is on and it can be read. */
    secret(): WebhookSecretState {
      const value = stored()
      if (!value.enabled) return { ok: false, reason: 'disabled' }
      if (value.secret === null) return { ok: false, reason: 'no_secret' }
      if (!secretBox) return { ok: false, reason: 'no_key' }
      try {
        return { ok: true, secret: secretBox.decrypt(value.secret), includePush: value.includePush }
      } catch {
        return { ok: false, reason: 'undecryptable' }
      }
    },

    /**
     * Replaces the secret with a new random one and returns it: the only time it is readable.
     * Deliveries signed with the old secret fail from now on. Throws without HINOMI_SECRET_KEY.
     */
    rotate(now: Date): string {
      if (!secretBox) throw new SecretKeyMissingError()
      const secret = generateWebhookSecret()
      settings.set(WEBHOOK_SETTING_KEYS.config, {
        ...stored(),
        secret: secretBox.encrypt(secret),
        secretCreatedAt: now.toISOString(),
      })
      return secret
    },

    /** Stores the switches given and keeps the rest. */
    update(patch: { enabled?: boolean; includePush?: boolean }): void {
      const value = stored()
      settings.set(WEBHOOK_SETTING_KEYS.config, {
        ...value,
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.includePush !== undefined && { includePush: patch.includePush }),
      })
    },

    recordDelivery(event: string, at: Date): void {
      settings.set(WEBHOOK_SETTING_KEYS.lastDelivery, { at: at.toISOString(), event })
    },

    lastDelivery(): { at: Date; event: string } | null {
      const value = settings.get(WEBHOOK_SETTING_KEYS.lastDelivery, lastDeliverySchema)
      return value ? { at: new Date(value.at), event: value.event } : null
    },
  }
}
