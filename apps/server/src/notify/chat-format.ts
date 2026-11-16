import type { Severity } from '@hinomi/shared'
import { escapeHtml } from './email.js'
import { fixRunRows, mainLink, type FixRunMessage } from './fix-run-format.js'
import type { MessageType } from './format.js'
import { SEVERITY_ORDER, type NotificationItem } from './items.js'
import {
  fitText,
  itemTexts,
  omittedLine,
  oneLine,
  plainItem,
  truncate,
  type ItemText,
} from './text.js'

// Messages for Slack, ntfy, Gotify and Telegram. Every one is built from the same text form of a
// finding (text.ts) and carries the same headline, summary lines, items and link as the Discord
// and email messages. Finding text is escaped for the markup of each service, so a package
// summary can neither ping a channel nor inject a link.

/** A batch of findings for one channel: what the notifier hands every kind. */
export interface ScanBatch {
  type: MessageType
  items: NotificationItem[]
  /** The headline. */
  summary: string
  /** Items cut by the limit. */
  omitted: number
  /** Lines under the headline (a summary's counts and link). */
  details: string[]
  /** What tapping the message opens: the finding of a one item batch, or the exposure view. */
  link: string | null
}

/** How loud a push message is, mapped to each service's own priority. */
export type Urgency = 'max' | 'high' | 'default' | 'low'

const URGENCY_OF: Record<Severity, Urgency> = {
  critical: 'max',
  high: 'high',
  moderate: 'default',
  low: 'low',
}

/** A batch's urgency: its most severe item for alerts, default for digests and tests. */
function batchUrgency(batch: ScanBatch): Urgency {
  if (batch.type === 'digest' || batch.type === 'test') return 'default'
  let worst: Severity = 'low'
  for (const item of batch.items) {
    if (SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst]) worst = item.severity
  }
  return URGENCY_OF[worst]
}

/** A title, a plain text body, a link and an urgency: what ntfy, Gotify and web push show. */
export interface PushText {
  title: string
  body: string
  link: string | null
  urgency: Urgency
}

/** ntfy.sh keeps messages up to 4096 bytes; stay well under it for multi byte text. */
const PUSH_BODY_MAX = 3500

export function scanPushText(batch: ScanBatch): PushText {
  const blocks = itemTexts(batch.type, batch.items).map(plainItem)
  const body = [batch.details.join('\n'), blocks.join('\n\n'), omittedLine(batch.omitted)]
    .filter((part) => part !== '')
    .join('\n\n')
  return {
    title: oneLine(batch.summary),
    body: fitText(body, PUSH_BODY_MAX),
    link: batch.link,
    urgency: batchUrgency(batch),
  }
}

const FIX_RUN_URGENCY: Record<string, Urgency> = {
  failed: 'high',
  checks_failing: 'high',
}

export function fixRunPushText(message: FixRunMessage): PushText {
  const rows = fixRunRows(message).map(([k, v]) => `${k}: ${v}`)
  return {
    title: oneLine(message.summary),
    body: fitText(rows.join('\n'), PUSH_BODY_MAX),
    link: mainLink(message),
    urgency: FIX_RUN_URGENCY[message.event] ?? 'default',
  }
}

// ---------------------------------------------------------------------------
// ntfy

const NTFY_PRIORITY: Record<Urgency, number> = { max: 5, high: 4, default: 3, low: 2 }

/** The JSON ntfy accepts at the server root. See https://docs.ntfy.sh/publish/#publish-as-json */
export interface NtfyMessage {
  topic: string
  title: string
  message: string
  priority: number
  tags: string[]
  click?: string
}

export function ntfyMessage(topic: string, text: PushText): NtfyMessage {
  return {
    topic,
    title: text.title,
    message: text.body,
    priority: NTFY_PRIORITY[text.urgency],
    tags: ['hinomi'],
    ...(text.link && { click: text.link }),
  }
}

// ---------------------------------------------------------------------------
// Gotify

const GOTIFY_PRIORITY: Record<Urgency, number> = { max: 8, high: 6, default: 4, low: 2 }

/** The JSON of POST /message. The body is shown as plain text, never as Markdown. */
export interface GotifyMessage {
  title: string
  message: string
  priority: number
  extras: Record<string, unknown>
}

export function gotifyMessage(text: PushText): GotifyMessage {
  return {
    title: text.title,
    message: text.body,
    priority: GOTIFY_PRIORITY[text.urgency],
    extras: {
      'client::display': { contentType: 'text/plain' },
      ...(text.link && { 'client::notification': { click: { url: text.link } } }),
    },
  }
}

// ---------------------------------------------------------------------------
// Slack

/** Slack mrkdwn: escape the three control characters so no text becomes a mention or a link. */
export function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** A link in mrkdwn. The URL is http(s) only (safeLink); `|` and `>` would end it early. */
function slackLink(url: string, label: string): string {
  return `<${url.replaceAll('|', '%7C').replaceAll('>', '%3E')}|${escapeSlack(label)}>`
}

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: false } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }
  | { type: 'divider' }

export interface SlackMessage {
  /** The notification and fallback text. */
  text: string
  blocks: SlackBlock[]
  unfurl_links: false
  unfurl_media: false
}

/** Slack refuses a section text over 3000 characters and a header over 150. */
const SLACK_SECTION_MAX = 2900
const SLACK_HEADER_MAX = 150

const section = (text: string): SlackBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, SLACK_SECTION_MAX) },
})

function slackItem(text: ItemText): SlackBlock {
  const title = text.link ? slackLink(text.link, text.title) : escapeSlack(text.title)
  const rows = text.rows.map(([k, v]) => `${escapeSlack(k)}: ${escapeSlack(v)}`)
  return section([`*${title}*`, ...rows].join('\n'))
}

function slackMessage(headline: string, blocks: SlackBlock[]): SlackMessage {
  const title = oneLine(headline)
  return {
    text: escapeSlack(title),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: truncate(title, SLACK_HEADER_MAX), emoji: false },
      },
      ...blocks,
    ],
    unfurl_links: false,
    unfurl_media: false,
  }
}

/** One Slack message per batch: at most 30 items plus the header lines, under the 50 block limit. */
export function slackScan(batch: ScanBatch): SlackMessage {
  const blocks: SlackBlock[] = []
  if (batch.details.length > 0) blocks.push(section(batch.details.map(escapeSlack).join('\n')))
  blocks.push(...itemTexts(batch.type, batch.items).map(slackItem))
  const tail = omittedLine(batch.omitted)
  if (tail)
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeSlack(tail) }] })
  return slackMessage(batch.summary, blocks)
}

export function slackFixRun(message: FixRunMessage): SlackMessage {
  const link = mainLink(message)
  const rows = fixRunRows(message).map(([k, v]) => `${escapeSlack(k)}: ${escapeSlack(v)}`)
  if (link) rows.push(slackLink(link, message.pr ? 'Open the pull request' : 'Open in Hinomi'))
  if (message.pr && message.hinomiUrl) rows.push(slackLink(message.hinomiUrl, 'Open in Hinomi'))
  return slackMessage(message.summary, [section(rows.join('\n'))])
}

// ---------------------------------------------------------------------------
// Telegram

/** sendMessage refuses text over 4096 characters after entity parsing; stay under it. */
const TELEGRAM_TEXT_MAX = 3900

export interface TelegramMessage {
  chat_id: string
  text: string
  parse_mode: 'HTML'
  link_preview_options: { is_disabled: true }
}

function telegramItem(text: ItemText): string {
  const title = text.link
    ? `<a href="${escapeHtml(text.link)}">${escapeHtml(text.title)}</a>`
    : escapeHtml(text.title)
  const rows = text.rows.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(truncate(v, 600))}`)
  return [`<b>${title}</b>`, ...rows].join('\n')
}

const telegramMessage = (chatId: string, text: string): TelegramMessage => ({
  chat_id: chatId,
  text,
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
})

/**
 * A batch as Telegram messages of at most TELEGRAM_TEXT_MAX characters, items kept in order and
 * never split. The first one carries the headline and summary lines. `items` is how many
 * findings each message covers, so each delivered message is recorded at once.
 */
export function telegramScan(
  chatId: string,
  batch: ScanBatch,
): { message: TelegramMessage; items: number }[] {
  const head = [`<b>${escapeHtml(oneLine(batch.summary))}</b>`, ...batch.details.map(escapeHtml)]
  const out: { parts: string[]; items: number }[] = [{ parts: [head.join('\n')], items: 0 }]
  let size = out[0]!.parts[0]!.length
  for (const entry of itemTexts(batch.type, batch.items)) {
    const block = telegramItem(entry)
    const current = out.at(-1)!
    if (current.items > 0 && size + block.length + 2 > TELEGRAM_TEXT_MAX) {
      out.push({ parts: [block], items: 1 })
      size = block.length
    } else {
      current.parts.push(block)
      current.items++
      size += block.length + 2
    }
  }
  const tail = omittedLine(batch.omitted)
  if (tail) out.at(-1)!.parts.push(`<i>${escapeHtml(tail)}</i>`)
  return out.map(({ parts, items }) => ({
    message: telegramMessage(chatId, parts.join('\n\n')),
    items,
  }))
}

export function telegramFixRun(chatId: string, message: FixRunMessage): TelegramMessage {
  const link = mainLink(message)
  const lines = [
    `<b>${escapeHtml(oneLine(message.summary))}</b>`,
    ...fixRunRows(message).map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`),
  ]
  if (link) {
    const label = message.pr ? 'Open the pull request' : 'Open in Hinomi'
    lines.push(`<a href="${escapeHtml(link)}">${label}</a>`)
  }
  if (message.pr && message.hinomiUrl) {
    lines.push(`<a href="${escapeHtml(message.hinomiUrl)}">Open in Hinomi</a>`)
  }
  return telegramMessage(chatId, lines.join('\n'))
}
