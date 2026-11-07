import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

/**
 * Which fix run events were already sent, so none repeats: `sent[runId][eventKey]` is the list of
 * channel ids that got it. An event that failed on one channel stays open for that channel and is
 * tried again on the run's next change; the channels that got it are not sent it twice.
 */
const stateSchema = z.object({
  sent: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
})

export type FixRunNotifyState = z.infer<typeof stateSchema>

export function readFixRunState(settings: SettingsRepository): FixRunNotifyState {
  return settings.get(NOTIFY_SETTING_KEYS.fixRunState, stateSchema) ?? { sent: {} }
}

export function writeFixRunState(settings: SettingsRepository, state: FixRunNotifyState): void {
  settings.set(NOTIFY_SETTING_KEYS.fixRunState, state)
}

export function wasSent(
  state: FixRunNotifyState,
  runId: number,
  eventKey: string,
  channelId: string,
): boolean {
  return state.sent[String(runId)]?.[eventKey]?.includes(channelId) ?? false
}

export function markSent(
  state: FixRunNotifyState,
  runId: number,
  eventKey: string,
  channelId: string,
): void {
  const run = (state.sent[String(runId)] ??= {})
  const channels = (run[eventKey] ??= [])
  if (!channels.includes(channelId)) channels.push(channelId)
}

/** Drops the records of runs that no longer exist. */
export function pruneFixRunState(
  state: FixRunNotifyState,
  exists: (runId: number) => boolean,
): void {
  for (const id of Object.keys(state.sent)) {
    if (!exists(Number(id))) delete state.sent[id]
  }
}
