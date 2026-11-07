import type { OnboardingStateDto } from '@hinomi/shared'
import { z } from 'zod'
import type { Repositories } from './repositories.js'

/** Settings keys of the first run state (plain JSON booleans). */
export const ONBOARDING_KEYS = {
  finished: 'onboarding.finished',
  alertsSkipped: 'onboarding.alertsSkipped',
} as const

/**
 * The first run state. `finished` falls back to "a scan has completed" when
 * it was never stored, so an install from before this setting existed does
 * not send people back to setup.
 */
export function readOnboarding(repositories: Repositories): OnboardingStateDto {
  const { settings, scanRuns } = repositories
  const finished =
    settings.get(ONBOARDING_KEYS.finished, z.boolean()) ??
    scanRuns.list(50).some((r) => r.status === 'succeeded' || r.status === 'partial')
  return {
    finished,
    alertsSkipped: settings.get(ONBOARDING_KEYS.alertsSkipped, z.boolean()) ?? false,
  }
}
