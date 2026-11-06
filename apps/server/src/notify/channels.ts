import { randomUUID } from 'node:crypto'
import { severitySchema, type Severity } from '@hinomi/shared'
import { z } from 'zod'
import type { SecretBox } from '../crypto/secret-box.js'
import type { SettingsRepository } from '../repository/index.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

export const CHANNEL_KINDS = ['discord', 'webhook'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

/** A channel as stored in settings. `url` is ciphertext when `urlEncrypted` is true. */
const storedChannelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().min(1),
  url: z.string().min(1),
  urlEncrypted: z.boolean(),
  enabled: z.boolean(),
  minSeverity: severitySchema,
})
const storedChannelsSchema = z.array(storedChannelSchema)
type StoredChannel = z.infer<typeof storedChannelSchema>

/** What the API may show: the URL is masked, never complete. */
export interface ChannelView {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  minSeverity: Severity
  /** Masked, see maskWebhookUrl. */
  url: string
  /** False when the URL sits in the database in clear text because HINOMI_SECRET_KEY is not set. */
  urlEncrypted: boolean
}

/** A channel with its URL in clear text. Internal: never log or return it. */
export interface ResolvedChannel {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  minSeverity: Severity
  url: string
}

export interface ChannelInput {
  kind: ChannelKind
  name: string
  url: string
  enabled?: boolean
  minSeverity?: Severity
}

export type ChannelPatch = Partial<Omit<ChannelInput, 'kind'>>

export class ChannelValidationError extends Error {
  override readonly name = 'ChannelValidationError'
}

export class ChannelNotFoundError extends Error {
  override readonly name = 'ChannelNotFoundError'
  constructor(id: string) {
    super(`Notification channel ${id} does not exist`)
  }
}

const DISCORD_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
])

/**
 * Shows enough of a webhook URL to tell channels apart without giving the
 * secret away: the origin and the last four characters.
 */
export function maskWebhookUrl(url: string): string {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return '****'
  }
  const tail = url.length >= 40 ? url.slice(-4) : ''
  return `${origin}/…${tail}`
}

/** Throws ChannelValidationError unless the URL fits the kind of channel. Never echoes the URL. */
export function assertValidChannelUrl(kind: ChannelKind, url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ChannelValidationError('The webhook URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ChannelValidationError('The webhook URL must be http or https')
  }
  if (kind === 'discord') {
    if (parsed.protocol !== 'https:' || !DISCORD_HOSTS.has(parsed.hostname)) {
      throw new ChannelValidationError(
        'A Discord webhook URL is https://discord.com/api/webhooks/...',
      )
    }
    if (!parsed.pathname.startsWith('/api/webhooks/')) {
      throw new ChannelValidationError(
        'A Discord webhook URL is https://discord.com/api/webhooks/...',
      )
    }
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new ChannelValidationError('A channel needs a name')
  return trimmed.slice(0, 80)
}

/**
 * Stores the notification channels in the settings table. Webhook URLs are
 * secrets (a Discord webhook URL lets anyone post): they are encrypted with
 * the secret box when HINOMI_SECRET_KEY is set. Without it they are stored in
 * clear text and `urlEncrypted` says so, because notifications must still
 * work on a setup that has no sources to protect.
 */
export function createChannelStore(settings: SettingsRepository, secretBox: SecretBox | null) {
  function load(): StoredChannel[] {
    return settings.get(NOTIFY_SETTING_KEYS.channels, storedChannelsSchema) ?? []
  }

  function save(channels: StoredChannel[]): void {
    settings.set(NOTIFY_SETTING_KEYS.channels, channels)
  }

  function seal(url: string): { url: string; urlEncrypted: boolean } {
    return secretBox
      ? { url: secretBox.encrypt(url), urlEncrypted: true }
      : { url, urlEncrypted: false }
  }

  /** Null when the URL is encrypted and cannot be decrypted (no key, or a different key). */
  function open(channel: StoredChannel): string | null {
    if (!channel.urlEncrypted) return channel.url
    if (!secretBox) return null
    try {
      return secretBox.decrypt(channel.url)
    } catch {
      return null
    }
  }

  function view(channel: StoredChannel): ChannelView {
    const plain = open(channel)
    return {
      id: channel.id,
      kind: channel.kind,
      name: channel.name,
      enabled: channel.enabled,
      minSeverity: channel.minSeverity,
      url: plain === null ? '****' : maskWebhookUrl(plain),
      urlEncrypted: channel.urlEncrypted,
    }
  }

  return {
    /** Every channel with its URL masked. Safe to return from the API. */
    list(): ChannelView[] {
      return load().map(view)
    },

    get(id: string): ChannelView | undefined {
      const found = load().find((c) => c.id === id)
      return found && view(found)
    },

    add(input: ChannelInput): ChannelView {
      const url = input.url.trim()
      assertValidChannelUrl(input.kind, url)
      const channel: StoredChannel = {
        id: randomUUID(),
        kind: input.kind,
        name: cleanName(input.name),
        ...seal(url),
        enabled: input.enabled ?? true,
        minSeverity: input.minSeverity ?? 'low',
      }
      save([...load(), channel])
      return view(channel)
    },

    /** Changes name, URL, enabled flag or minimum severity. Omitted fields stay as they are. */
    update(id: string, patch: ChannelPatch): ChannelView {
      const channels = load()
      const index = channels.findIndex((c) => c.id === id)
      const current = channels[index]
      if (!current) throw new ChannelNotFoundError(id)
      const next: StoredChannel = { ...current }
      if (patch.name !== undefined) next.name = cleanName(patch.name)
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.minSeverity !== undefined) next.minSeverity = patch.minSeverity
      if (patch.url !== undefined) {
        const url = patch.url.trim()
        assertValidChannelUrl(current.kind, url)
        Object.assign(next, seal(url))
      }
      channels[index] = next
      save(channels)
      return view(next)
    },

    remove(id: string): boolean {
      const channels = load()
      const rest = channels.filter((c) => c.id !== id)
      if (rest.length === channels.length) return false
      save(rest)
      return true
    },

    /** Channels with their URL in clear text. Only for sending. Channels whose URL cannot be read are skipped. */
    resolve(options: { onlyEnabled?: boolean } = {}): ResolvedChannel[] {
      const out: ResolvedChannel[] = []
      for (const channel of load()) {
        if (options.onlyEnabled && !channel.enabled) continue
        const url = open(channel)
        if (url === null) continue
        out.push({
          id: channel.id,
          kind: channel.kind,
          name: channel.name,
          enabled: channel.enabled,
          minSeverity: channel.minSeverity,
          url,
        })
      }
      return out
    },
  }
}

export type ChannelStore = ReturnType<typeof createChannelStore>
