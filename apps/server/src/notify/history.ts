import type { FindingNotification } from '@hinomi/shared'
import type { FindingEventRow } from '../db/schema.js'
import type { SettingsRepository } from '../repository/index.js'
import { createChannelStore } from './channels.js'
import { readState } from './state.js'

/**
 * Immediate notifications that announced a finding, newest first, read from the sent-state.
 * Only the latest announcement per channel is kept there, and digests are not recorded per
 * finding, so this is what was last sent, not a full log.
 */
export function findingNotifications(
  settings: SettingsRepository,
  findingId: number,
  events: readonly FindingEventRow[],
): FindingNotification[] {
  const state = readState(settings)
  // Names only: the URL is never opened here, so no secret box is needed.
  const channels = new Map(
    createChannelStore(settings, null)
      .list()
      .map((c) => [c.id, c]),
  )
  const byId = new Map(events.map((e) => [e.id, e]))
  const key = String(findingId)
  const out: FindingNotification[] = []
  for (const [channelId, sent] of Object.entries(state.immediate)) {
    const eventId = sent[key]
    const event = eventId === undefined ? undefined : byId.get(eventId)
    if (eventId === undefined || !event) continue
    const channel = channels.get(channelId)
    const at = state.sentAt[channelId]?.[key] ?? event.at.getTime()
    out.push({
      channelId,
      channelName: channel?.name ?? null,
      channelKind: channel?.kind ?? null,
      event: event.type,
      eventId,
      sentAt: new Date(at).toISOString(),
    })
  }
  return out.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
}
