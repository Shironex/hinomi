import { randomUUID } from 'node:crypto'
import {
  SMTP_SECURITY_MODES,
  severitySchema,
  type EmailChannelInput,
  type EmailChannelPatch,
  type EmailChannelView,
  type Severity,
  type SmtpSecurity,
} from '@hinomi/shared'
import { z } from 'zod'
import type { SecretBox } from '../crypto/secret-box.js'
import type { SettingsRepository } from '../repository/index.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

export const CHANNEL_KINDS = ['discord', 'webhook', 'email'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

/** SMTP settings as stored. `password` is ciphertext when `passwordEncrypted` is true. */
const storedEmailSchema = z.object({
  host: z.string().min(1),
  port: z.number().int(),
  security: z.enum(SMTP_SECURITY_MODES),
  user: z.string().nullable(),
  password: z.string().nullable(),
  passwordEncrypted: z.boolean(),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
})
type StoredEmail = z.infer<typeof storedEmailSchema>

/**
 * A channel as stored in settings. `url` is ciphertext when `urlEncrypted` is
 * true. An email channel has no URL (empty string) and carries `email`.
 */
const storedChannelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().min(1),
  url: z.string(),
  urlEncrypted: z.boolean(),
  email: storedEmailSchema.optional(),
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
  /** False when the URL (or the SMTP password) sits in the database in clear text because HINOMI_SECRET_KEY is not set. */
  urlEncrypted: boolean
  /** Email channels only. The password is never part of the view. */
  email?: EmailChannelView
}

/** SMTP settings with the password in clear text. Internal: never log or return it. */
export interface ResolvedEmail {
  host: string
  port: number
  security: SmtpSecurity
  user: string | null
  password: string | null
  from: string
  to: string[]
}

/** A channel with its URL in clear text. Internal: never log or return it. */
export interface ResolvedChannel {
  id: string
  kind: ChannelKind
  name: string
  enabled: boolean
  minSeverity: Severity
  /** Empty for an email channel. */
  url: string
  /** Email channels only. */
  email?: ResolvedEmail
}

export interface ChannelInput {
  kind: ChannelKind
  name: string
  /** Discord and webhook channels. */
  url?: string
  /** Email channels. */
  email?: EmailChannelInput
  enabled?: boolean
  minSeverity?: Severity
}

export interface ChannelPatch {
  name?: string
  url?: string
  email?: EmailChannelPatch
  enabled?: boolean
  minSeverity?: Severity
}

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

/** Throws ChannelValidationError unless the channel is given what its kind needs. */
function assertInputShape(input: ChannelInput): void {
  if (input.kind === 'email') {
    if (!input.email) throw new ChannelValidationError('An email channel needs SMTP settings')
    if (input.url) throw new ChannelValidationError('An email channel has no URL')
  } else {
    if (!input.url?.trim()) throw new ChannelValidationError('The webhook URL is required')
    if (input.email) throw new ChannelValidationError('Only an email channel has SMTP settings')
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new ChannelValidationError('A channel needs a name')
  return trimmed.slice(0, 80)
}

/**
 * Stores the notification channels in the settings table. Webhook URLs and
 * SMTP passwords are secrets (a Discord webhook URL lets anyone post): they are encrypted with
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

  function unseal(value: string, encrypted: boolean): string | null {
    if (!encrypted) return value
    if (!secretBox) return null
    try {
      return secretBox.decrypt(value)
    } catch {
      return null
    }
  }

  /** Null when the URL is encrypted and cannot be decrypted (no key, or a different key). */
  function open(channel: StoredChannel): string | null {
    return unseal(channel.url, channel.urlEncrypted)
  }

  /** Null when the password is encrypted and cannot be decrypted. A channel without a password opens with `password: null`. */
  function openEmail(email: StoredEmail): ResolvedEmail | null {
    let password: string | null = null
    if (email.password !== null) {
      password = unseal(email.password, email.passwordEncrypted)
      if (password === null) return null
    }
    return {
      host: email.host,
      port: email.port,
      security: email.security,
      user: email.user,
      password,
      from: email.from,
      to: email.to,
    }
  }

  function sealEmail(input: EmailChannelInput, keep: StoredEmail | undefined): StoredEmail {
    const user = input.user?.trim() || null
    let password: string | null = keep?.password ?? null
    let passwordEncrypted = keep?.passwordEncrypted ?? false
    if (input.password !== undefined) {
      if (input.password === '') {
        password = null
        passwordEncrypted = false
      } else {
        const sealed = seal(input.password)
        password = sealed.url
        passwordEncrypted = sealed.urlEncrypted
      }
    }
    return {
      host: input.host.trim(),
      port: input.port,
      security: input.security,
      user,
      password: user === null ? null : password,
      passwordEncrypted,
      from: input.from.trim(),
      to: input.to.map((address) => address.trim()),
    }
  }

  function view(channel: StoredChannel): ChannelView {
    if (channel.kind === 'email' && channel.email) {
      const { email } = channel
      return {
        id: channel.id,
        kind: 'email',
        name: channel.name,
        enabled: channel.enabled,
        minSeverity: channel.minSeverity,
        url: `${email.host}:${email.port}`,
        urlEncrypted: email.password === null || email.passwordEncrypted,
        email: {
          host: email.host,
          port: email.port,
          security: email.security,
          user: email.user,
          from: email.from,
          to: email.to,
          passwordSet: email.password !== null,
        },
      }
    }
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
      assertInputShape(input)
      const url = input.url?.trim() ?? ''
      if (input.kind !== 'email') assertValidChannelUrl(input.kind, url)
      const channel: StoredChannel = {
        id: randomUUID(),
        kind: input.kind,
        name: cleanName(input.name),
        ...(input.email
          ? { url: '', urlEncrypted: false, email: sealEmail(input.email, undefined) }
          : seal(url)),
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
      if (patch.email !== undefined) {
        if (current.kind !== 'email' || !current.email) {
          throw new ChannelValidationError('Only an email channel has SMTP settings')
        }
        const merged = {
          host: patch.email.host ?? current.email.host,
          port: patch.email.port ?? current.email.port,
          security: patch.email.security ?? current.email.security,
          user: patch.email.user ?? current.email.user ?? undefined,
          from: patch.email.from ?? current.email.from,
          to: patch.email.to ?? current.email.to,
          ...(patch.email.password !== undefined && { password: patch.email.password }),
        }
        next.email = sealEmail(merged, current.email)
      }
      if (patch.url !== undefined) {
        if (current.kind === 'email') {
          throw new ChannelValidationError('An email channel has no URL')
        }
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

    /** Channels with their URL or SMTP password in clear text. Only for sending. Channels whose secret cannot be read are skipped. */
    resolve(options: { onlyEnabled?: boolean } = {}): ResolvedChannel[] {
      const out: ResolvedChannel[] = []
      for (const channel of load()) {
        if (options.onlyEnabled && !channel.enabled) continue
        const base = {
          id: channel.id,
          kind: channel.kind,
          name: channel.name,
          enabled: channel.enabled,
          minSeverity: channel.minSeverity,
        }
        if (channel.kind === 'email') {
          const email = channel.email && openEmail(channel.email)
          if (email) out.push({ ...base, url: '', email })
          continue
        }
        const url = open(channel)
        if (url === null) continue
        out.push({ ...base, url })
      }
      return out
    },
  }
}

export type ChannelStore = ReturnType<typeof createChannelStore>
