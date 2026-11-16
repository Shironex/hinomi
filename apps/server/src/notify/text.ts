import { EVENT_LABELS, type MessageType } from './format.js'
import type { NotificationItem } from './items.js'

// The text form of a finding, shared by every channel that is not Discord or JSON: email,
// Slack, ntfy, Gotify, Telegram. Each renders the same title and rows in its own markup.

/** Only http and https links go into a message; anything else is left out. */
export function safeLink(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}

export const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Header values and titles must stay on one line. */
export const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()

/** One finding as a title, label and value rows, and its link. */
export interface ItemText {
  title: string
  rows: [string, string][]
  link: string | null
}

/** The lines of one finding. Digests label every item with its event; reopened items always are. */
export function itemText(item: NotificationItem, labelEvent: boolean): ItemText {
  const prefix = labelEvent || item.event === 'reopened' ? `${EVENT_LABELS[item.event]}: ` : ''
  const rows: [string, string][] = []
  if (item.summary) rows.push(['Summary', item.summary])
  if (item.repo) rows.push(['Repository', item.repo])
  if (item.deployments.length > 0) {
    rows.push(['Deployment', item.deployments.map((d) => `${d.name} (${d.reach})`).join(', ')])
  }
  if (item.installedVersion) rows.push(['Installed', item.installedVersion])
  if (item.fixedIn) rows.push(['Fixed in', item.fixedIn])
  if (item.sources.length > 0) rows.push(['Sources', item.sources.join(', ')])
  const ids = [item.advisory, ...item.cves].filter((id): id is string => id !== null)
  if (ids.length > 0) rows.push(['Advisory', ids.join(', ')])
  return {
    title: `${prefix}[${item.severity.toUpperCase()}] ${item.title}`,
    rows,
    link: safeLink(item.url),
  }
}

export function itemTexts(type: MessageType, items: readonly NotificationItem[]): ItemText[] {
  return items.map((item) => itemText(item, type === 'digest'))
}

/** The line under a digest or summary that cut items. Empty when nothing was cut. */
export function omittedLine(omitted: number): string {
  return omitted > 0 ? `${omitted} more not shown. Open Hinomi to see everything.` : ''
}

/** One finding as plain text: the title, then an indented line per row and the link. */
export function plainItem(text: ItemText): string {
  return [
    text.title,
    ...text.rows.map(([k, v]) => `  ${k}: ${v}`),
    ...(text.link ? [`  Open: ${text.link}`] : []),
  ].join('\n')
}

/**
 * Cuts plain text to at most `max` characters at a line break, saying how much was left out.
 * Push services refuse or truncate long messages.
 */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = '\n… cut here. Open Hinomi to see everything.'
  const room = max - marker.length
  const cut = text.lastIndexOf('\n', room)
  return `${text.slice(0, cut > 0 ? cut : room)}${marker}`
}
