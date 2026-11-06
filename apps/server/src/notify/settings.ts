import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/** Settings keys the notifier reads and writes. */
export const NOTIFY_SETTING_KEYS = {
  /** List of channels (see channels.ts). Webhook URLs inside are encrypted when a secret key is set. */
  channels: 'notify.channels',
  /** Public address of this Hinomi, used for the links back to a finding. Example: https://hinomi.example.dev */
  publicBaseUrl: 'notify.publicBaseUrl',
  /** Hour of the day (0 to 23, server local time) the daily digest goes out. */
  digestHour: 'notify.digestHour',
  /** What was already sent, so nothing repeats (see state.ts). */
  state: 'notify.state',
} as const

export const DEFAULT_DIGEST_HOUR = 8

const baseUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'The public base URL must be http or https')
  .transform((value) => value.replace(/\/+$/, ''))

export const digestHourSchema = z.number().int().min(0).max(23)

export interface NotifySettings {
  /** Without trailing slash. Null when not configured: messages then carry no link. */
  publicBaseUrl: string | null
  digestHour: number
}

export function readNotifySettings(settings: SettingsRepository): NotifySettings {
  return {
    publicBaseUrl: settings.get(NOTIFY_SETTING_KEYS.publicBaseUrl, baseUrlSchema) ?? null,
    digestHour:
      settings.get(NOTIFY_SETTING_KEYS.digestHour, digestHourSchema) ?? DEFAULT_DIGEST_HOUR,
  }
}

/** Validates and stores the public base URL. An empty string clears it. Throws on an invalid URL. */
export function writePublicBaseUrl(settings: SettingsRepository, value: string): void {
  if (value.trim() === '') {
    settings.remove(NOTIFY_SETTING_KEYS.publicBaseUrl)
    return
  }
  settings.set(NOTIFY_SETTING_KEYS.publicBaseUrl, baseUrlSchema.parse(value))
}

/** Validates and stores the digest hour. Throws unless it is an integer from 0 to 23. */
export function writeDigestHour(settings: SettingsRepository, hour: number): void {
  settings.set(NOTIFY_SETTING_KEYS.digestHour, digestHourSchema.parse(hour))
}
