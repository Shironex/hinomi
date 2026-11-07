import type { FindingTier } from '@hinomi/shared'
import type { FindingEventRow } from '../db/schema.js'
import type { SecretBox } from '../crypto/secret-box.js'
import type { Repositories } from '../repository/index.js'
import {
  findingChangesSince,
  listRankedFindings,
  tierOf,
  type RankedFinding,
  type ScanLogger,
  type ScanSummary,
} from '../scan/index.js'
import { ChannelNotFoundError, createChannelStore, type ResolvedChannel } from './channels.js'
import { defaultSleep, deliver, type DeliverOptions } from './deliver.js'
import { createSmtpSender, emailContent, type MailSender } from './email.js'
import {
  digestSummary,
  discordMessages,
  exposureUrl,
  immediateSummary,
  limitDigest,
  sampleItem,
  SUMMARY_THRESHOLD,
  SUMMARY_TOP,
  summaryCounts,
  summaryText,
  webhookPayload,
  type MessageType,
  type SummaryCounts,
} from './format.js'
import {
  buildItem,
  isMessageFinding,
  meetsMinimum,
  type ItemEvent,
  type MessageFinding,
  type NotificationItem,
} from './items.js'
import { readNotifySettings } from './settings.js'
import { isPrimed, pruneState, readState, writeState, type NotifyState } from './state.js'
import { currentTime } from '@hinomi/shared'

export interface NotifierOptions {
  repositories: Repositories
  /** Needed to encrypt webhook URLs. Without it they are stored in clear text. */
  secretBox?: SecretBox | null
  fetch?: typeof fetch
  now?: () => Date
  log?: ScanLogger
  /** Waits between delivery retries. Tests replace it. */
  sleep?: (ms: number) => Promise<void>
  /** Sends email channels. Defaults to SMTP through nodemailer; tests inject a recorder. */
  mailSender?: MailSender
  /** Overrides for the retry policy (tests). */
  delivery?: Pick<
    DeliverOptions,
    'maxAttempts' | 'baseDelayMs' | 'maxBackoffMs' | 'maxRetryAfterMs' | 'timeoutMs'
  >
}

export interface TestResult {
  ok: boolean
  /** Why it failed. Never contains the webhook URL. */
  error?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const silent: ScanLogger = { info() {}, warn() {}, error() {} }

/** Event types in the finding history that a digest reports, and what they mean. */
const DIGEST_EVENTS: Record<string, ItemEvent> = {
  opened: 'opened',
  reopened: 'reopened',
  fixed: 'fixed',
  resolved: 'resolved',
  snooze_expired: 'expired',
  acceptance_expired: 'expired',
}

/** Not reported, but they end a story: a finding dismissed upstream must not be announced as new. */
const SILENCING_EVENT = 'dismissed_upstream'

const isAnnouncement = (type: string) => type === 'opened' || type === 'reopened'

/**
 * True when a finding needs a message right away: a critical or high
 * advisory, or any blind spot, on something that is deployed.
 */
function isImmediate(ranked: RankedFinding): ranked is MessageFinding {
  if (!isMessageFinding(ranked)) return false
  // The lockfile is already patched: GitHub's alert is stale, nothing to announce.
  if (ranked.patchedInLockfile) return false
  if (ranked.state !== 'open' && ranked.state !== 'fixing') return false
  if (ranked.deployments.length === 0) return false
  if (ranked.kind === 'blind_spot') return true
  return ranked.factors.severity === 'critical' || ranked.factors.severity === 'high'
}

/**
 * Sends Discord, generic webhook and email notifications about findings. Self
 * contained: the scheduler calls `handleScanFinished` after every scan and
 * `sendDigest` once a day (see `msUntilNextDigest`).
 */
export function createNotifier(options: NotifierOptions) {
  const { repositories } = options
  const now = options.now ?? (() => currentTime())
  const log = options.log ?? silent
  const channels = createChannelStore(repositories.settings, options.secretBox ?? null)
  const delivery: DeliverOptions = {
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    log,
    ...options.delivery,
  }
  const sendMail =
    options.mailSender ??
    createSmtpSender({
      log,
      sleep: delivery.sleep,
      ...(delivery.maxAttempts !== undefined && { maxAttempts: delivery.maxAttempts }),
      ...(delivery.baseDelayMs !== undefined && { baseDelayMs: delivery.baseDelayMs }),
    })

  // One send at a time: the sent-state is read, then written after the awaits.
  let queue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  function rankedById(): Map<number, RankedFinding> {
    return new Map(listRankedFindings(repositories).map((r) => [r.finding.id, r]))
  }

  /** What a summary adds to a message: the lines under the headline, the counts and the link. */
  interface SummaryExtra {
    details: string[]
    counts: SummaryCounts
    link: string | null
  }

  /** Posts items to one channel in as many messages as the kind needs; `onSent` gets each delivered batch. */
  async function send(
    channel: ResolvedChannel,
    type: MessageType,
    items: NotificationItem[],
    summary: string,
    onSent: (batch: NotificationItem[]) => void = () => {},
    omitted = 0,
    extra?: SummaryExtra,
  ): Promise<void> {
    if (channel.kind === 'email' && channel.email) {
      await sendMail(channel.email, {
        from: channel.email.from,
        to: channel.email.to,
        ...emailContent(type, items, summary, omitted, extra?.details),
      })
      onSent(items)
      return
    }
    if (channel.kind === 'webhook') {
      const body = webhookPayload(
        type,
        items,
        summary,
        now(),
        omitted,
        extra ? { counts: extra.counts, link: extra.link } : {},
      )
      await deliver(channel.url, body, delivery)
      onSent(items)
      return
    }
    const content = extra ? [summary, ...extra.details].join('\n') : summary
    let offset = 0
    for (const message of discordMessages(type, items, content)) {
      await deliver(channel.url, message, delivery)
      onSent(items.slice(offset, offset + message.embeds.length))
      offset += message.embeds.length
    }
  }

  function failed(channel: ResolvedChannel, what: string, error: unknown): void {
    log.warn('could not send to a notification channel', {
      what,
      channel: channel.name,
      channelId: channel.id,
      error: error instanceof Error ? error.message : 'unknown error',
    })
  }

  /** The latest opened or reopened event of a finding: what an announcement is about. */
  function announcementEvent(findingId: number): FindingEventRow | undefined {
    return repositories.findings.listEvents(findingId).find((e) => isAnnouncement(e.type))
  }

  /** One finding to announce after a scan, with what orders and counts it. */
  interface Pending {
    item: NotificationItem
    eventId: number
    rank: number
    tier: FindingTier
  }

  /** New and reopened findings of a scan that need a message, highest rank first. */
  function pendingAnnouncements(summary: ScanSummary, baseUrl: string | null): Pending[] {
    // A dismissal never seen before emits `opened` first: the dismissal in the same summary wins.
    const dismissed = new Set(
      summary.changes.filter((c) => c.change === 'dismissed_upstream').map((c) => c.findingId),
    )
    const candidates = summary.changes.filter(
      (c) => (c.change === 'opened' || c.change === 'reopened') && !dismissed.has(c.findingId),
    )
    if (candidates.length === 0) return []

    const ranked = rankedById()
    const pending: Pending[] = []
    const seen = new Set<number>()
    for (const change of candidates) {
      if (seen.has(change.findingId)) continue
      seen.add(change.findingId)
      const found = ranked.get(change.findingId)
      const event = announcementEvent(change.findingId)
      if (!found || !event || !isImmediate(found)) continue
      pending.push({
        item: buildItem(found, event.type === 'reopened' ? 'reopened' : 'opened', baseUrl),
        eventId: event.id,
        rank: found.rank,
        tier: tierOf(found),
      })
    }
    return pending.sort((a, b) => b.rank - a.rank || a.item.findingId - b.item.findingId)
  }

  /**
   * Announces a scan's items on one channel. Its first scan, and any scan with
   * more than SUMMARY_THRESHOLD items for it, gets one summary (counts per tier
   * and severity, the top SUMMARY_TOP items, the exposure view link) instead of
   * a message per item. Each delivered message is recorded per finding at once,
   * so a stop in the middle of a long send loses nothing.
   */
  async function announce(
    channel: ResolvedChannel,
    pending: readonly Pending[],
    state: NotifyState,
    baseUrl: string | null,
  ): Promise<void> {
    const sent = (state.immediate[channel.id] ??= {})
    const todo = pending.filter(
      (p) =>
        meetsMinimum(p.item.severity, channel.minSeverity) &&
        sent[String(p.item.findingId)] !== p.eventId,
    )
    if (todo.length === 0) return
    const eventIds = new Map(todo.map((p) => [p.item.findingId, p.eventId]))
    const record = (batch: readonly NotificationItem[]) => {
      const sentAt = (state.sentAt[channel.id] ??= {})
      for (const item of batch) {
        sent[String(item.findingId)] = eventIds.get(item.findingId) ?? 0
        sentAt[String(item.findingId)] = now().getTime()
      }
      writeState(repositories.settings, state)
    }
    const firstScan = !isPrimed(state, channel.id)
    try {
      if (!firstScan && todo.length <= SUMMARY_THRESHOLD) {
        const items = todo.map((p) => p.item)
        await send(channel, 'immediate', items, immediateSummary(items), record)
        return
      }
      const top = todo.slice(0, SUMMARY_TOP)
      const counts = summaryCounts(todo.map((p) => ({ tier: p.tier, severity: p.item.severity })))
      const link = exposureUrl(baseUrl)
      const { headline, lines } = summaryText(counts, { firstScan, shown: top.length, link })
      let recorded = false
      await send(
        channel,
        'summary',
        top.map((p) => p.item),
        headline,
        () => {
          // The summary stands for every item: all of them are announced once it is delivered.
          if (recorded) return
          recorded = true
          record(todo.map((p) => p.item))
        },
        todo.length - top.length,
        { details: lines, counts, link },
      )
    } catch (error) {
      // Not recorded as sent: the daily digest still carries it.
      failed(channel, firstScan ? 'first scan summary' : 'immediate message', error)
    }
  }

  async function notifyImmediate(summary: ScanSummary): Promise<void> {
    const enabled = channels.resolve({ onlyEnabled: true })
    if (enabled.length === 0) return
    const state = pruneState(readState(repositories.settings), new Set(enabled.map((c) => c.id)))
    try {
      const { publicBaseUrl } = readNotifySettings(repositories.settings)
      const pending = pendingAnnouncements(summary, publicBaseUrl)
      if (pending.length === 0) return
      for (const channel of enabled) await announce(channel, pending, state, publicBaseUrl)
    } finally {
      // Every enabled channel has been through a scan now: later scans announce item by item.
      for (const channel of enabled) state.primed[channel.id] ??= now().getTime()
      writeState(repositories.settings, state)
    }
  }

  /** Items a channel's digest covers: changes since its last digest, minus what was announced already. */
  function digestItems(
    channel: ResolvedChannel,
    since: Date,
    state: NotifyState,
    ranked: Map<number, RankedFinding>,
    baseUrl: string | null,
  ): NotificationItem[] {
    const items: NotificationItem[] = []
    for (const { finding, events } of findingChangesSince(repositories, since)) {
      const relevant = events.filter((e) => e.type in DIGEST_EVENTS || e.type === SILENCING_EVENT)
      const first = relevant[0]
      const last = relevant.at(-1)
      const found = ranked.get(finding.id)
      // Coverage notes are not news: they show in the app, never in a message.
      if (!first || !last || !found || !isMessageFinding(found)) continue
      if (found.patchedInLockfile) continue
      if (last.type === SILENCING_EVENT) continue
      const event = DIGEST_EVENTS[last.type] as ItemEvent
      // Opened and gone again within the window: nothing changed on net.
      if (first.type === 'opened' && (event === 'fixed' || event === 'resolved')) continue
      if (
        isAnnouncement(last.type) &&
        state.immediate[channel.id]?.[String(finding.id)] === last.id
      )
        continue
      const item = buildItem(found, event, baseUrl)
      if (meetsMinimum(item.severity, channel.minSeverity)) items.push(item)
    }
    return items
  }

  async function notifyDigest(): Promise<void> {
    const enabled = channels.resolve({ onlyEnabled: true })
    const at = now()
    const state = pruneState(readState(repositories.settings), new Set(enabled.map((c) => c.id)))
    if (enabled.length === 0) {
      writeState(repositories.settings, state)
      return
    }
    const ranked = rankedById()
    const { publicBaseUrl } = readNotifySettings(repositories.settings)

    for (const channel of enabled) {
      const since = new Date((state.digestSince[channel.id] ?? at.getTime() - DAY_MS) + 1)
      const items = digestItems(channel, since, state, ranked, publicBaseUrl)
      if (items.length > 0) {
        const { shown, omitted } = limitDigest(items)
        try {
          await send(
            channel,
            'digest',
            shown,
            digestSummary(shown.length, items.length),
            undefined,
            omitted,
          )
        } catch (error) {
          failed(channel, 'daily digest', error)
          continue // keep digestSince: the next digest covers this period too
        }
      }
      state.digestSince[channel.id] = at.getTime()
      writeState(repositories.settings, state)
    }
  }

  return {
    /** Manage channels (add, update, remove, list masked). */
    channels,

    /** Call after every finished scan. Never throws. */
    handleScanFinished(summary: ScanSummary): Promise<void> {
      return exclusive(async () => {
        try {
          await notifyImmediate(summary)
        } catch (error) {
          log.error('notifications for a finished scan failed', {
            error: error instanceof Error ? error.message : 'unknown error',
          })
        }
      })
    },

    /** Sends everything else that changed since each channel's last digest, if anything did. Never throws. */
    sendDigest(): Promise<void> {
      return exclusive(async () => {
        try {
          await notifyDigest()
        } catch (error) {
          log.error('the daily digest failed', {
            error: error instanceof Error ? error.message : 'unknown error',
          })
        }
      })
    },

    /** Sends a sample message to one channel, enabled or not. Throws ChannelNotFoundError for an unknown id. */
    sendTest(channelId: string): Promise<TestResult> {
      return exclusive(async () => {
        const channel = channels.resolve().find((c) => c.id === channelId)
        if (!channel) throw new ChannelNotFoundError(channelId)
        const { publicBaseUrl } = readNotifySettings(repositories.settings)
        try {
          await send(channel, 'test', [sampleItem(publicBaseUrl)], 'Hinomi test message')
          return { ok: true }
        } catch (error) {
          failed(channel, 'test message', error)
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      })
    },
  }
}

export type Notifier = ReturnType<typeof createNotifier>
