import {
  RUNTIME_BEHIND_DEFAULT_RELEASES,
  RUNTIME_BEHIND_MAX_RELEASES,
  RUNTIME_BEHIND_MIN_RELEASES,
  SUPPORT_WINDOW_DEFAULT_DAYS,
  SUPPORT_WINDOW_MAX_DAYS,
  SUPPORT_WINDOW_MIN_DAYS,
} from '@hinomi/shared'
import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/** The setting behind the warning window of the support checks (Q8). */
export const SUPPORT_WINDOW_KEY = 'support.windowDays'

/** The settings behind the "behind latest" rule of Rust and Bun (Q12a). */
export const BEHIND_RELEASES_KEYS = {
  rust: 'support.rustBehindReleases',
  bun: 'support.bunBehindReleases',
} as const

const windowDaysSchema = z.number().int().min(SUPPORT_WINDOW_MIN_DAYS).max(SUPPORT_WINDOW_MAX_DAYS)
const behindSchema = z
  .number()
  .int()
  .min(RUNTIME_BEHIND_MIN_RELEASES)
  .max(RUNTIME_BEHIND_MAX_RELEASES)

/** Days before end of life at which a line turns to a warning; 90 until changed. */
export function readSupportWindowDays(settings: SettingsRepository): number {
  return settings.get(SUPPORT_WINDOW_KEY, windowDaysSchema) ?? SUPPORT_WINDOW_DEFAULT_DAYS
}

/** How many releases a pinned Rust or Bun version may be behind the latest before it warns; 4 each until changed. */
export function readBehindReleases(settings: SettingsRepository): { rust: number; bun: number } {
  return {
    rust: settings.get(BEHIND_RELEASES_KEYS.rust, behindSchema) ?? RUNTIME_BEHIND_DEFAULT_RELEASES,
    bun: settings.get(BEHIND_RELEASES_KEYS.bun, behindSchema) ?? RUNTIME_BEHIND_DEFAULT_RELEASES,
  }
}
