import {
  SUPPORT_WINDOW_DEFAULT_DAYS,
  SUPPORT_WINDOW_MAX_DAYS,
  SUPPORT_WINDOW_MIN_DAYS,
} from '@hinomi/shared'
import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/** The setting behind the warning window of the support checks (Q8). */
export const SUPPORT_WINDOW_KEY = 'support.windowDays'

const windowDaysSchema = z.number().int().min(SUPPORT_WINDOW_MIN_DAYS).max(SUPPORT_WINDOW_MAX_DAYS)

/** Days before end of life at which a line turns to a warning; 90 until changed. */
export function readSupportWindowDays(settings: SettingsRepository): number {
  return settings.get(SUPPORT_WINDOW_KEY, windowDaysSchema) ?? SUPPORT_WINDOW_DEFAULT_DAYS
}
