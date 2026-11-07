import type { FindingTier, Severity } from '@hinomi/shared'
import { compareItems, type ItemEvent, type NotificationItem } from './items.js'

export type MessageType = 'immediate' | 'summary' | 'digest' | 'test'

/** Items per Discord message: the API accepts at most 10 embeds. */
export const DISCORD_EMBEDS_PER_MESSAGE = 10
/**
 * Discord refuses a message whose embeds hold more than 6000 characters in
 * total. Messages are split well below that (the JSON size over counts).
 */
export const DISCORD_EMBED_CHARS_PER_MESSAGE = 5000
/** More new items than this in one scan go out as one summary, not a message each. */
export const SUMMARY_THRESHOLD = 10
/** Items a summary shows in full, most urgent first. */
export const SUMMARY_TOP = 5
/** A digest carries at most this many items per channel; the rest is counted in the summary. */
export const DIGEST_ITEM_LIMIT = 30

const COLORS: Record<Severity, number> = {
  critical: 0xb42318,
  high: 0xe8590c,
  moderate: 0xf0b429,
  low: 0x6b7a90,
}

export const EVENT_LABELS: Record<ItemEvent, string> = {
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

/**
 * Splits items into Discord messages of at most ten embeds and
 * DISCORD_EMBED_CHARS_PER_MESSAGE characters, items kept in order. The first
 * one carries `content`.
 */
export function discordMessages(
  type: MessageType,
  items: NotificationItem[],
  content: string,
): DiscordMessage[] {
  const labelEvent = type === 'digest'
  const embeds = items.map((item) => discordEmbed(item, { labelEvent }))
  const batches: DiscordEmbed[][] = [[]]
  let chars = 0
  for (const embed of embeds) {
    const size = JSON.stringify(embed).length
    const current = batches.at(-1)!
    if (
      current.length > 0 &&
      (current.length >= DISCORD_EMBEDS_PER_MESSAGE ||
        chars + size > DISCORD_EMBED_CHARS_PER_MESSAGE)
    ) {
      batches.push([embed])
      chars = size
    } else {
      current.push(embed)
      chars += size
    }
  }
  return batches.map((batch, i) => ({
    ...(i === 0 && { content: truncate(content, 2000) }),
    embeds: batch,
    allowed_mentions: { parse: [] },
  }))
}

/** The body a generic webhook receives. Documented in docs/notifications.md: keep it stable. */
export interface WebhookPayload {
  schema: 'hinomi.notification.v1'
  type: MessageType
  sentAt: string
  summary: string
  items: NotificationItem[]
  /** Items left out of a digest or a summary because of the per message limit. */
  omitted: number
  /** Only on a summary: every item the summary stands for, counted. */
  counts?: SummaryCounts
  /** Only on a summary: the exposure view, null without a public base URL. */
  link?: string | null
}

export function webhookPayload(
  type: MessageType,
  items: NotificationItem[],
  summary: string,
  sentAt: Date,
  omitted = 0,
  extra: Pick<WebhookPayload, 'counts' | 'link'> = {},
): WebhookPayload {
  return {
    schema: 'hinomi.notification.v1',
    type,
    sentAt: sentAt.toISOString(),
    summary,
    items,
    omitted,
    ...extra,
  }
}

/** What a summary counts: every new item of the scan for that channel. */
export interface SummaryCounts {
  total: number
  /** Per display tier, only the tiers that have items. */
  byTier: Partial<Record<FindingTier, number>>
  bySeverity: Record<Severity, number>
}

const TIER_LABELS: Record<FindingTier, string> = {
  blind_spot: 'Blind spots',
  exposed: 'Exposed on a public app',
  internal: 'Deployed, internal only',
  released: 'Released desktop apps',
  public_low: 'Deployed and public, moderate or low',
  dev: 'Deployed, dev dependencies only',
  not_deployed: 'Not deployed',
  patched: 'Patched in the lockfile',
  coverage: 'Image only',
}
const TIER_ORDER = Object.keys(TIER_LABELS) as FindingTier[]
const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low']

export function summaryCounts(items: readonly { tier: FindingTier; severity: Severity }[]) {
  const counts: SummaryCounts = {
    total: items.length,
    byTier: {},
    bySeverity: { critical: 0, high: 0, moderate: 0, low: 0 },
  }
  for (const { tier, severity } of items) {
    counts.byTier[tier] = (counts.byTier[tier] ?? 0) + 1
    counts.bySeverity[severity]++
  }
  return counts
}

/** The exposure view (the overview) of this Hinomi, null without a public base URL. */
export function exposureUrl(baseUrl: string | null): string | null {
  return baseUrl ? `${baseUrl}/` : null
}

/**
 * The text of a summary: a headline (also the email subject) and the lines
 * under it, counts per tier and severity, a pointer to the top items and the
 * exposure view link.
 */
export function summaryText(
  counts: SummaryCounts,
  options: { firstScan: boolean; shown: number; link: string | null },
): { headline: string; lines: string[] } {
  const n = counts.total
  const items = `${n} item${n === 1 ? '' : 's'}`
  const headline = options.firstScan
    ? `Hinomi first scan: ${items} need${n === 1 ? 's' : ''} attention`
    : `Hinomi: ${n} new item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention`
  const tiers = TIER_ORDER.filter((t) => counts.byTier[t]).map(
    (t) => `${TIER_LABELS[t]}: ${counts.byTier[t]}`,
  )
  const severities = SEVERITIES.filter((s) => counts.bySeverity[s] > 0).map(
    (s) => `${counts.bySeverity[s]} ${s}`,
  )
  const lines = [
    ...tiers,
    ...(severities.length > 0 ? [`By severity: ${severities.join(', ')}`] : []),
    ...(options.link ? [`Exposure view: ${options.link}`] : []),
    options.shown < n ? `The ${options.shown} most urgent, by rank:` : 'Most urgent first:',
  ]
  return { headline, lines }
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
