import type { Severity } from '@hinomi/shared'
import { compareItems, type ItemEvent, type NotificationItem } from './items.js'

export type MessageType = 'immediate' | 'digest' | 'test'

/** Items per Discord message: the API accepts at most 10 embeds. */
export const DISCORD_EMBEDS_PER_MESSAGE = 10
/** A digest carries at most this many items per channel; the rest is counted in the summary. */
export const DIGEST_ITEM_LIMIT = 30

const COLORS: Record<Severity, number> = {
  critical: 0xb42318,
  high: 0xe8590c,
  moderate: 0xf0b429,
  low: 0x6b7a90,
}

const EVENT_LABELS: Record<ItemEvent, string> = {
  opened: 'New',
  reopened: 'Reopened',
  fixed: 'Fixed',
  resolved: 'Resolved',
  expired: 'Snooze ended',
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

interface DiscordField {
  name: string
  value: string
  inline?: boolean
}

export interface DiscordEmbed {
  title: string
  url?: string
  description?: string
  color: number
  fields: DiscordField[]
}

export interface DiscordMessage {
  content?: string
  embeds: DiscordEmbed[]
  /** Never ping anyone, whatever a package summary contains. */
  allowed_mentions: { parse: [] }
}

export function discordEmbed(
  item: NotificationItem,
  options: { labelEvent: boolean },
): DiscordEmbed {
  const prefix =
    options.labelEvent || item.event === 'reopened' ? `${EVENT_LABELS[item.event]}: ` : ''
  const fields: DiscordField[] = []
  if (item.repo) fields.push({ name: 'Repository', value: item.repo, inline: true })
  if (item.deployments.length > 0) {
    const text = item.deployments.map((d) => `${d.name} (${d.reach})`).join(', ')
    fields.push({ name: 'Deployment', value: truncate(text, 1024), inline: true })
  }
  if (item.installedVersion)
    fields.push({ name: 'Installed', value: item.installedVersion, inline: true })
  if (item.fixedIn) fields.push({ name: 'Fixed in', value: item.fixedIn, inline: true })
  if (item.sources.length > 0)
    fields.push({ name: 'Sources', value: item.sources.join(', '), inline: true })
  const ids = [item.advisory, ...item.cves].filter((id): id is string => id !== null)
  if (ids.length > 0)
    fields.push({ name: 'Advisory', value: truncate(ids.join(', '), 1024), inline: true })

  return {
    title: truncate(`${prefix}[${item.severity.toUpperCase()}] ${item.title}`, 256),
    ...(item.url && { url: item.url }),
    ...(item.summary && { description: truncate(item.summary, 400) }),
    color: COLORS[item.severity],
    fields,
  }
}

/** Splits items into Discord messages. The first one carries `content`. */
export function discordMessages(
  type: MessageType,
  items: NotificationItem[],
  content: string,
): DiscordMessage[] {
  const labelEvent = type === 'digest'
  const embeds = items.map((item) => discordEmbed(item, { labelEvent }))
  const messages: DiscordMessage[] = []
  for (let i = 0; i < Math.max(embeds.length, 1); i += DISCORD_EMBEDS_PER_MESSAGE) {
    messages.push({
      ...(i === 0 && { content }),
      embeds: embeds.slice(i, i + DISCORD_EMBEDS_PER_MESSAGE),
      allowed_mentions: { parse: [] },
    })
  }
  return messages
}

/** The body a generic webhook receives. Documented in docs/notifications.md: keep it stable. */
export interface WebhookPayload {
  schema: 'hinomi.notification.v1'
  type: MessageType
  sentAt: string
  summary: string
  items: NotificationItem[]
  /** Items left out of a digest because of the per message limit. */
  omitted: number
}

export function webhookPayload(
  type: MessageType,
  items: NotificationItem[],
  summary: string,
  sentAt: Date,
  omitted = 0,
): WebhookPayload {
  return {
    schema: 'hinomi.notification.v1',
    type,
    sentAt: sentAt.toISOString(),
    summary,
    items,
    omitted,
  }
}

export function immediateSummary(items: NotificationItem[]): string {
  return items.length === 1
    ? 'Hinomi: 1 new item needs attention'
    : `Hinomi: ${items.length} new items need attention`
}

export function digestSummary(shown: number, total: number): string {
  const base = `Hinomi daily digest: ${total} change${total === 1 ? '' : 's'}`
  return shown < total ? `${base} (showing the ${shown} most urgent)` : base
}

/** Sorts by severity and cuts to the digest limit. */
export function limitDigest(items: NotificationItem[]): {
  shown: NotificationItem[]
  omitted: number
} {
  const sorted = [...items].sort(compareItems)
  return {
    shown: sorted.slice(0, DIGEST_ITEM_LIMIT),
    omitted: Math.max(0, sorted.length - DIGEST_ITEM_LIMIT),
  }
}

/** A sample message that shows what the real ones look like. Fictional data. */
export function sampleItem(baseUrl: string | null): NotificationItem {
  return {
    event: 'opened',
    findingId: 0,
    kind: 'advisory',
    severity: 'high',
    title: 'example-lib',
    blindSpotType: null,
    repo: 'kestrel-co/harbor-web',
    package: 'example-lib',
    ecosystem: 'npm',
    advisory: 'GHSA-0000-0000-0000',
    cves: [],
    summary: 'This is a test message from Hinomi. Nothing is wrong.',
    installedVersion: '1.2.3',
    fixedIn: '1.2.4',
    deployments: [{ name: 'harbor-web', reach: 'public', server: null }],
    sources: ['github'],
    url: baseUrl,
  }
}
