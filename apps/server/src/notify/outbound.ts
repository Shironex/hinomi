import type { ResolvedChannel } from './channels.js'
import {
  fixRunPushText,
  gotifyMessage,
  ntfyMessage,
  scanPushText,
  slackFixRun,
  slackScan,
  telegramFixRun,
  telegramScan,
  type PushText,
  type ScanBatch,
} from './chat-format.js'
import type { DeliveryTarget } from './deliver.js'
import { fixRunDiscord, fixRunWebhook, type FixRunMessage } from './fix-run-format.js'
import { discordMessages, webhookPayload, type SummaryCounts } from './format.js'

// What one channel receives, as HTTP requests: where each goes, its body, and how many of the
// batch's items it covers (so the notifier records each delivered request at once). Email is
// not here: it goes over SMTP (email.ts).

export interface OutboundRequest {
  target: DeliveryTarget
  body: unknown
  /** Items of the batch this request carries, in order. */
  items: number
}

/** A channel that is posted to over HTTP: every kind but email. */
export type HttpChannel = ResolvedChannel & { kind: Exclude<ResolvedChannel['kind'], 'email'> }

export function isHttpChannel(channel: ResolvedChannel): channel is HttpChannel {
  return channel.kind !== 'email'
}

const TELEGRAM_API = 'https://api.telegram.org'

/** The URL a channel posts to, the headers its token needs and the secrets to scrub. */
function targetOf(channel: HttpChannel): DeliveryTarget {
  const base = {
    allowPrivate: channel.allowPrivate,
    secrets: [channel.secret],
  }
  switch (channel.kind) {
    case 'ntfy': {
      // ntfy takes JSON at the server root, with the topic in the body.
      const url = new URL(channel.url)
      const path = url.pathname.replace(/\/+$/, '')
      url.pathname = `${path.slice(0, path.lastIndexOf('/'))}/`
      return {
        ...base,
        url: url.toString(),
        ...(channel.secret && { headers: { authorization: `Bearer ${channel.secret}` } }),
      }
    }
    case 'gotify':
      return {
        ...base,
        url: `${channel.url.replace(/\/+$/, '')}/message`,
        headers: { 'x-gotify-key': channel.secret ?? '' },
      }
    case 'telegram':
      return { ...base, url: `${TELEGRAM_API}/bot${channel.secret ?? ''}/sendMessage` }
    case 'webhook':
      return { ...base, url: channel.url, signingSecret: channel.secret }
    default:
      return { ...base, url: channel.url }
  }
}

/** The topic of an ntfy channel: the last segment of its URL. */
function ntfyTopic(channel: HttpChannel): string {
  return new URL(channel.url).pathname.replace(/\/+$/, '').split('/').at(-1) ?? ''
}

/** The single request of a push channel (ntfy, Gotify). */
function pushRequest(channel: HttpChannel, text: PushText, items: number): OutboundRequest {
  const body = channel.kind === 'ntfy' ? ntfyMessage(ntfyTopic(channel), text) : gotifyMessage(text)
  return { target: targetOf(channel), body, items }
}

/** What a summary adds to the webhook payload. */
export interface WebhookExtra {
  counts?: SummaryCounts
  link?: string | null
}

/** The requests that carry a batch of findings to one channel. */
export function scanRequests(
  channel: HttpChannel,
  batch: ScanBatch,
  sentAt: Date,
  webhookExtra: WebhookExtra = {},
): OutboundRequest[] {
  const target = targetOf(channel)
  const count = batch.items.length
  switch (channel.kind) {
    case 'webhook': {
      const body = webhookPayload(
        batch.type,
        batch.items,
        batch.summary,
        sentAt,
        batch.omitted,
        webhookExtra,
      )
      return [{ target, body, items: count }]
    }
    case 'slack':
      return [{ target, body: slackScan(batch), items: count }]
    case 'ntfy':
    case 'gotify':
      return [pushRequest(channel, scanPushText(batch), count)]
    case 'telegram':
      return telegramScan(channel.chatId ?? '', batch).map(({ message, items }) => ({
        target,
        body: message,
        items,
      }))
    case 'discord': {
      const content =
        batch.details.length > 0 ? [batch.summary, ...batch.details].join('\n') : batch.summary
      return discordMessages(batch.type, batch.items, content).map((message) => ({
        target,
        body: message,
        items: message.embeds.length,
      }))
    }
  }
}

/** The request that carries one fix run event to one channel. */
export function fixRunRequest(
  channel: HttpChannel,
  message: FixRunMessage,
  sentAt: Date,
): OutboundRequest {
  const target = targetOf(channel)
  switch (channel.kind) {
    case 'webhook':
      return { target, body: fixRunWebhook(message, sentAt), items: 0 }
    case 'slack':
      return { target, body: slackFixRun(message), items: 0 }
    case 'ntfy':
    case 'gotify':
      return pushRequest(channel, fixRunPushText(message), 0)
    case 'telegram':
      return { target, body: telegramFixRun(channel.chatId ?? '', message), items: 0 }
    case 'discord':
      return { target, body: fixRunDiscord(message), items: 0 }
  }
}
