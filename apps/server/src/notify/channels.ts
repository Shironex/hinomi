import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import {
  CHANNEL_KIND_FIELDS,
  NOTIFY_CHANNEL_KINDS,
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
import { isPublicAddress } from '../net/public-address.js'
import type { SettingsRepository } from '../repository/index.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

export const CHANNEL_KINDS = NOTIFY_CHANNEL_KINDS
export type ChannelKind = (typeof CHANNEL_KINDS)[number]
type UrlKind = Exclude<ChannelKind, 'email'>

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
 * true. An email channel has no URL (empty string) and carries `email`; a
 * Telegram channel has no URL either. `secret` (the signing secret, access,
 * app or bot token) is ciphertext when `secretEncrypted` is true. Channels
 * stored before these fields existed have none of them (see allowsPrivate).
 */
const storedChannelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().min(1),
  url: z.string(),
  urlEncrypted: z.boolean(),
  email: storedEmailSchema.optional(),
  secret: z.string().nullable().optional(),
  secretEncrypted: z.boolean().optional(),
  chatId: z.string().optional(),
  allowPrivate: z.boolean().optional(),
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
  /** May post to private and loopback addresses. */
  allowPrivate: boolean
  /** Kinds with a secret beside the URL: whether one is stored. Never the secret itself. */
  secretSet?: boolean
  /** Telegram only. */
  chatId?: string
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
  /** Empty for an email or Telegram channel. */
  url: string
  /** Email channels only. */
  email?: ResolvedEmail
  /** The signing secret, access, app or bot token, in clear text. Null when none is set. */
  secret: string | null
  /** Telegram only, else null. */
  chatId: string | null
  /** May post to private and loopback addresses. */
  allowPrivate: boolean
}

export interface ChannelInput {
  kind: ChannelKind
  name: string
  /** Every kind with a URL (see CHANNEL_KIND_FIELDS). */
  url?: string
  /** The signing secret, access, app or bot token (see CHANNEL_KIND_FIELDS). */
  secret?: string
  /** Telegram channels. */
  chatId?: string
  /** Kinds that may post to a private address. Off by default. */
  allowPrivate?: boolean
  /** Email channels. */
  email?: EmailChannelInput
  enabled?: boolean
  minSeverity?: Severity
}

export interface ChannelPatch {
  name?: string
  url?: string
  /** An empty string removes an optional secret. */
  secret?: string
  chatId?: string
  allowPrivate?: boolean
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
const SLACK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com'])
/** An ntfy topic: letters, digits, dash and underscore, at most 64. */
const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/
/** A Telegram bot token as BotFather gives it: `<bot id>:<secret>`. */
const TELEGRAM_BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/
/** An ntfy or Gotify token goes into a header: one line of printable characters, no spaces. */
const HEADER_TOKEN = /^[!-~]{1,500}$/

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

/** True for a host that is a literal private address or a localhost name. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isIP(host) !== 0 && !isPublicAddress(host)
}

/**
 * Why Hinomi will not post to this URL, or null. Names a literal private address or localhost
 * unless the channel allows private addresses; host names are checked again when they resolve,
 * at connection time (see net/public-fetch.ts). Never echoes the URL.
 */
export function privateTargetProblem(url: string, allowPrivate: boolean): string | null {
  if (allowPrivate) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'The URL is not a valid URL'
  }
  return isPrivateHost(parsed.hostname)
    ? 'The URL points to a private or loopback address. Allow private addresses on this channel to use it.'
    : null
}

const DISCORD_SHAPE = 'A Discord webhook URL is https://discord.com/api/webhooks/...'
const SLACK_SHAPE = 'A Slack incoming webhook URL is https://hooks.slack.com/services/...'

/**
 * Throws ChannelValidationError unless the URL fits the kind of channel, and, unless private
 * addresses are allowed, points to a public address. Never echoes the URL.
 */
export function assertValidChannelUrl(kind: UrlKind, url: string, allowPrivate = false): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ChannelValidationError('The URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ChannelValidationError('The URL must be http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ChannelValidationError('The URL must not carry a user name or password')
  }
  if (kind === 'discord') {
    if (parsed.protocol !== 'https:' || !DISCORD_HOSTS.has(parsed.hostname))
      throw new ChannelValidationError(DISCORD_SHAPE)
    if (!parsed.pathname.startsWith('/api/webhooks/'))
      throw new ChannelValidationError(DISCORD_SHAPE)
  }
  if (kind === 'slack') {
    if (parsed.protocol !== 'https:' || !SLACK_HOSTS.has(parsed.hostname))
      throw new ChannelValidationError(SLACK_SHAPE)
  }
  if (kind === 'ntfy') {
    const topic = parsed.pathname.replace(/\/+$/, '').split('/').at(-1) ?? ''
    if (!NTFY_TOPIC.test(topic) || parsed.search !== '') {
      throw new ChannelValidationError(
        'An ntfy URL is the server and the topic, for example https://ntfy.sh/hinomi-alerts',
      )
    }
  }
  const problem = privateTargetProblem(url, allowPrivate && CHANNEL_KIND_FIELDS[kind].allowPrivate)
  if (problem) throw new ChannelValidationError(problem)
}

function assertValidSecret(kind: UrlKind, secret: string): void {
  if ((kind === 'ntfy' || kind === 'gotify') && !HEADER_TOKEN.test(secret)) {
    throw new ChannelValidationError(
      'The token is one line of printable characters, without spaces',
    )
  }
  if (kind === 'telegram' && !TELEGRAM_BOT_TOKEN.test(secret)) {
    throw new ChannelValidationError(
      'A Telegram bot token looks like 123456789:AA... (ask @BotFather for it)',
    )
  }
}

/** Throws ChannelValidationError unless the channel is given what its kind needs. */
function assertInputShape(input: ChannelInput): void {
  if (input.kind === 'email') {
    if (!input.email) throw new ChannelValidationError('An email channel needs SMTP settings')
    if (input.url) throw new ChannelValidationError('An email channel has no URL')
    if (input.secret || input.chatId || input.allowPrivate)
      throw new ChannelValidationError('An email channel has only SMTP settings')
    return
  }
  const fields = CHANNEL_KIND_FIELDS[input.kind]
  if (fields.url === 'required' && !input.url?.trim())
    throw new ChannelValidationError('The URL is required')
  if (input.email) throw new ChannelValidationError('Only an email channel has SMTP settings')
  if (fields.url === 'none' && input.url)
    throw new ChannelValidationError('This channel has no URL')
  if (fields.secret === 'required' && !input.secret?.trim())
    throw new ChannelValidationError('The token is required')
  if (fields.secret === 'none' && input.secret)
    throw new ChannelValidationError('This channel has no token or secret')
  if (fields.chatId && !input.chatId?.trim())
    throw new ChannelValidationError('The chat id is required')
  if (!fields.chatId && input.chatId)
    throw new ChannelValidationError('Only Telegram has a chat id')
  if (!fields.allowPrivate && input.allowPrivate)
    throw new ChannelValidationError('This channel always posts to a public service')
}

/**
 * Whether a stored channel may post to a private address. A generic webhook stored before the
 * setting existed keeps doing so (it could always reach any address); every other channel, and
 * every new one, must opt in.
 */
function allowsPrivate(channel: StoredChannel): boolean {
  if (channel.kind === 'email' || !CHANNEL_KIND_FIELDS[channel.kind].allowPrivate) return false
  return channel.allowPrivate ?? channel.kind === 'webhook'
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

  /** The stored secret in clear text: null when there is none, undefined when it cannot be read. */
  function openSecret(channel: StoredChannel): string | null | undefined {
    if (channel.secret === undefined || channel.secret === null) return null
    return unseal(channel.secret, channel.secretEncrypted ?? false) ?? undefined
  }

  function sealSecret(secret: string | null): Pick<StoredChannel, 'secret' | 'secretEncrypted'> {
    if (secret === null) return { secret: null, secretEncrypted: false }
    const sealed = seal(secret)
    return { secret: sealed.url, secretEncrypted: sealed.urlEncrypted }
  }

  /** What the list shows instead of a URL for a channel that has none. */
  function displayUrl(channel: StoredChannel): string {
    if (channel.kind === 'telegram') return `Telegram chat ${channel.chatId ?? ''}`.trim()
    const plain = open(channel)
    return plain === null ? '****' : maskWebhookUrl(plain)
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
        allowPrivate: false,
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
    const fields = channel.kind === 'email' ? null : CHANNEL_KIND_FIELDS[channel.kind]
    const hasSecret = channel.secret !== undefined && channel.secret !== null
    const urlEncrypted =
      (fields?.url === 'none' || channel.urlEncrypted) &&
      (!hasSecret || (channel.secretEncrypted ?? false))
    return {
      id: channel.id,
      kind: channel.kind,
      name: channel.name,
      enabled: channel.enabled,
      minSeverity: channel.minSeverity,
      url: displayUrl(channel),
      urlEncrypted,
      allowPrivate: allowsPrivate(channel),
      ...(fields && fields.secret !== 'none' && { secretSet: hasSecret }),
      ...(channel.chatId !== undefined && { chatId: channel.chatId }),
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
      const base = {
        id: randomUUID(),
        kind: input.kind,
        name: cleanName(input.name),
        enabled: input.enabled ?? true,
        minSeverity: input.minSeverity ?? 'low',
      }
      let channel: StoredChannel
      if (input.kind === 'email') {
        channel = {
          ...base,
          url: '',
          urlEncrypted: false,
          email: sealEmail(input.email as EmailChannelInput, undefined),
        }
      } else {
        const fields = CHANNEL_KIND_FIELDS[input.kind]
        const allowPrivate = fields.allowPrivate && (input.allowPrivate ?? false)
        const url = input.url?.trim() ?? ''
        if (fields.url === 'required') assertValidChannelUrl(input.kind, url, allowPrivate)
        const secret = input.secret?.trim() || null
        if (secret !== null) assertValidSecret(input.kind, secret)
        channel = {
          ...base,
          ...(fields.url === 'required' ? seal(url) : { url: '', urlEncrypted: false }),
          ...(fields.secret !== 'none' && sealSecret(secret)),
          ...(fields.chatId && { chatId: input.chatId?.trim() ?? '' }),
          ...(fields.allowPrivate && { allowPrivate }),
        }
      }
      save([...load(), channel])
      return view(channel)
    },

    /** Changes name, URL, secret, chat, private flag, enabled flag or minimum severity. Omitted fields stay as they are. */
    update(id: string, patch: ChannelPatch): ChannelView {
      const channels = load()
      const index = channels.findIndex((c) => c.id === id)
      const current = channels[index]
      if (!current) throw new ChannelNotFoundError(id)
      const next: StoredChannel = { ...current }
      if (patch.name !== undefined) next.name = cleanName(patch.name)
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.minSeverity !== undefined) next.minSeverity = patch.minSeverity
      if (current.kind === 'email') {
        if (patch.url !== undefined) throw new ChannelValidationError('An email channel has no URL')
        if (
          patch.secret !== undefined ||
          patch.chatId !== undefined ||
          patch.allowPrivate !== undefined
        ) {
          throw new ChannelValidationError('An email channel has only SMTP settings')
        }
        if (patch.email !== undefined && current.email) {
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
        channels[index] = next
        save(channels)
        return view(next)
      }
      if (patch.email !== undefined) {
        throw new ChannelValidationError('Only an email channel has SMTP settings')
      }
      const kind = current.kind
      const fields = CHANNEL_KIND_FIELDS[kind]
      if (patch.allowPrivate !== undefined) {
        if (!fields.allowPrivate && patch.allowPrivate)
          throw new ChannelValidationError('This channel always posts to a public service')
        if (fields.allowPrivate) next.allowPrivate = patch.allowPrivate
      }
      if (patch.chatId !== undefined) {
        if (!fields.chatId) throw new ChannelValidationError('Only Telegram has a chat id')
        next.chatId = patch.chatId.trim()
      }
      if (patch.secret !== undefined) {
        if (fields.secret === 'none')
          throw new ChannelValidationError('This channel has no token or secret')
        const secret = patch.secret.trim() || null
        if (secret === null && fields.secret === 'required')
          throw new ChannelValidationError('The token is required')
        if (secret !== null) assertValidSecret(kind, secret)
        Object.assign(next, sealSecret(secret))
      }
      if (patch.url !== undefined) {
        if (fields.url === 'none') throw new ChannelValidationError('This channel has no URL')
        const url = patch.url.trim()
        assertValidChannelUrl(kind, url, allowsPrivate(next))
        Object.assign(next, seal(url))
      } else if (fields.url === 'required' && allowsPrivate(current) && !allowsPrivate(next)) {
        // Turning private addresses off: the stored URL must still pass.
        const url = open(current)
        const problem = url === null ? null : privateTargetProblem(url, false)
        if (problem) throw new ChannelValidationError(problem)
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

    /** Channels with their URL, secret or SMTP password in clear text. Only for sending. Channels whose secret cannot be read are skipped. */
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
          chatId: channel.chatId ?? null,
          allowPrivate: allowsPrivate(channel),
        }
        if (channel.kind === 'email') {
          const email = channel.email && openEmail(channel.email)
          if (email) out.push({ ...base, url: '', secret: null, email })
          continue
        }
        const url = CHANNEL_KIND_FIELDS[channel.kind].url === 'none' ? '' : open(channel)
        const secret = openSecret(channel)
        if (url === null || secret === undefined) continue
        out.push({ ...base, url, secret })
      }
      return out
    },
  }
}

export type ChannelStore = ReturnType<typeof createChannelStore>
