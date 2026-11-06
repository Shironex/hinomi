import type { FindingEventRow } from '../db/schema.js'
import type { SecretBox } from '../crypto/secret-box.js'
import type { Repositories } from '../repository/index.js'
import {
  findingChangesSince,
  listRankedFindings,
  type RankedFinding,
  type ScanLogger,
  type ScanSummary,
} from '../scan/index.js'
import { ChannelNotFoundError, createChannelStore, type ResolvedChannel } from './channels.js'
import { defaultSleep, deliver, type DeliverOptions } from './deliver.js'
import {
  DISCORD_EMBEDS_PER_MESSAGE,
  digestSummary,
  discordMessages,
  immediateSummary,
  limitDigest,
  sampleItem,
  webhookPayload,
  type MessageType,
} from './format.js'
import { buildItem, meetsMinimum, type ItemEvent, type NotificationItem } from './items.js'
import { readNotifySettings } from './settings.js'
import { pruneState, readState, writeState, type NotifyState } from './state.js'

export interface NotifierOptions {
  repositories: Repositories
  /** Needed to encrypt webhook URLs. Without it they are stored in clear text. */
  secretBox?: SecretBox | null
  fetch?: typeof fetch
  now?: () => Date
  log?: ScanLogger
  /** Waits between delivery retries. Tests replace it. */
  sleep?: (ms: number) => Promise<void>
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

const isAnnouncement = (type: string) => type === 'opened' || type === 'reopened'

/**
 * True when a finding needs a message right away: a critical or high
 * advisory, or any blind spot, on something that is deployed.
 */
function isImmediate(ranked: RankedFinding): boolean {
  if (ranked.state !== 'open' && ranked.state !== 'fixing') return false
  if (ranked.deployments.length === 0) return false
  if (ranked.kind === 'blind_spot') return true
  return ranked.factors.severity === 'critical' || ranked.factors.severity === 'high'
}

/**
 * Sends Discord and generic webhook notifications about findings. Self
 * contained: the scheduler calls `handleScanFinished` after every scan and
 * `sendDigest` once a day (see `msUntilNextDigest`).
 */
export function createNotifier(options: NotifierOptions) {
  const { repositories } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? silent
  const channels = createChannelStore(repositories.settings, options.secretBox ?? null)
  const delivery: DeliverOptions = {
    fetch: options.fetch ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    log,
    ...options.delivery,
  }

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

  /** Posts items to one channel in as many messages as the kind needs; `onSent` gets each delivered batch. */
  async function send(
    channel: ResolvedChannel,
    type: MessageType,
    items: NotificationItem[],
    summary: string,
    onSent: (batch: NotificationItem[]) => void = () => {},
    omitted = 0,
  ): Promise<void> {
    if (channel.kind === 'webhook') {
      await deliver(channel.url, webhookPayload(type, items, summary, now(), omitted), delivery)
      onSent(items)
      return
    }
    const messages = discordMessages(type, items, summary)
    for (const [index, message] of messages.entries()) {
      await deliver(channel.url, message, delivery)
      onSent(
        items.slice(index * DISCORD_EMBEDS_PER_MESSAGE, (index + 1) * DISCORD_EMBEDS_PER_MESSAGE),
      )
    }
  }

  function failed(channel: ResolvedChannel, what: string, error: unknown): void {
    log.warn(`could not send the ${what} to a notification channel`, {
      channel: channel.name,
      channelId: channel.id,
      error: error instanceof Error ? error.message : 'unknown error',
    })
  }

  /** The latest opened or reopened event of a finding: what an announcement is about. */
  function announcementEvent(findingId: number): FindingEventRow | undefined {
    return repositories.findings.listEvents(findingId).find((e) => isAnnouncement(e.type))
  }

  async function notifyImmediate(summary: ScanSummary): Promise<void> {
    const enabled = channels.resolve({ onlyEnabled: true })
    if (enabled.length === 0) return
    const candidates = summary.changes.filter(
      (c) => c.change === 'opened' || c.change === 'reopened',
    )
    if (candidates.length === 0) return

    const ranked = rankedById()
    const { publicBaseUrl } = readNotifySettings(repositories.settings)
    const pending: { item: NotificationItem; eventId: number }[] = []
    const seen = new Set<number>()
    for (const change of candidates) {
      if (seen.has(change.findingId)) continue
      seen.add(change.findingId)
      const found = ranked.get(change.findingId)
      const event = announcementEvent(change.findingId)
      if (!found || !event || !isImmediate(found)) continue
      pending.push({
        item: buildItem(found, event.type === 'reopened' ? 'reopened' : 'opened', publicBaseUrl),
        eventId: event.id,
      })
    }
    if (pending.length === 0) return

    const state = pruneState(readState(repositories.settings), new Set(enabled.map((c) => c.id)))
    for (const channel of enabled) {
      const sent = (state.immediate[channel.id] ??= {})
      const todo = pending.filter(
        (p) =>
          meetsMinimum(p.item.severity, channel.minSeverity) &&
          sent[String(p.item.findingId)] !== p.eventId,
      )
      if (todo.length === 0) continue
      const eventIds = new Map(todo.map((p) => [p.item.findingId, p.eventId]))
      try {
        await send(
          channel,
          'immediate',
          todo.map((p) => p.item),
          immediateSummary(todo.map((p) => p.item)),
          (batch) => {
            for (const item of batch)
              sent[String(item.findingId)] = eventIds.get(item.findingId) ?? 0
          },
        )
      } catch (error) {
        // Not recorded as sent: the daily digest still carries it.
        failed(channel, 'immediate message', error)
      }
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
      const relevant = events.filter((e) => e.type in DIGEST_EVENTS)
      const first = relevant[0]
      const last = relevant.at(-1)
      const found = ranked.get(finding.id)
      if (!first || !last || !found) continue
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
