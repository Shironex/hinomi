import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

/**
 * What was already sent, per channel.
 *
 * `immediate[channelId][findingId]` is the id of the `opened` or `reopened`
 * event that was announced. The same event is never announced twice; a new
 * `reopened` event (the finding came back) has a new id and is announced again.
 *
 * `sentAt[channelId][findingId]` is when (unix ms) that announcement went out.
 * State written before it existed has no entry; readers fall back to the event time.
 *
 * `digestSince[channelId]` is the time (unix ms) up to which the digest of
 * that channel covers. It only moves when the digest was delivered.
 *
 * `primed[channelId]` is when (unix ms) the channel went through its first
 * scan. Until then, a scan sends that channel one summary instead of a message
 * per finding (see `isPrimed`).
 */
const stateSchema = z.object({
  immediate: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  sentAt: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  digestSince: z.record(z.string(), z.number()).default({}),
  primed: z.record(z.string(), z.number()).default({}),
})

export type NotifyState = z.infer<typeof stateSchema>

export function readState(settings: SettingsRepository): NotifyState {
  return (
    settings.get(NOTIFY_SETTING_KEYS.state, stateSchema) ?? {
      immediate: {},
      sentAt: {},
      digestSince: {},
      primed: {},
    }
  )
}

/**
 * True once a channel went through a scan. A channel with anything sent
 * already (state written before `primed` existed) counts as primed too.
 */
export function isPrimed(state: NotifyState, channelId: string): boolean {
  return (
    state.primed[channelId] !== undefined ||
    Object.keys(state.immediate[channelId] ?? {}).length > 0 ||
    state.digestSince[channelId] !== undefined
  )
}

export function writeState(settings: SettingsRepository, state: NotifyState): void {
  settings.set(NOTIFY_SETTING_KEYS.state, state)
}

/** Drops records of channels that no longer exist. */
export function pruneState(state: NotifyState, channelIds: ReadonlySet<string>): NotifyState {
  const keep = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => channelIds.has(id)))
  return {
    immediate: keep(state.immediate),
    sentAt: keep(state.sentAt),
    digestSince: keep(state.digestSince),
    primed: keep(state.primed),
  }
}
