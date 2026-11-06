import {
  onboardingStateSchema,
  updateOnboardingRequestSchema,
  type OnboardingStateDto,
} from '@hinomi/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Repositories } from '../../repository/index.js'
import type { ApiDeps } from '../deps.js'
import { readJson, send } from '../http.js'

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

export function onboardingRoutes(deps: ApiDeps) {
  const app = new Hono()
  const { repositories } = deps

  app.get('/', (c) => send(c, onboardingStateSchema, readOnboarding(repositories)))

  app.patch('/', async (c) => {
    const body = await readJson(c, updateOnboardingRequestSchema)
    repositories.db.transaction(() => {
      if (body.finished !== undefined) {
        repositories.settings.set(ONBOARDING_KEYS.finished, body.finished)
      }
      if (body.alertsSkipped !== undefined) {
        repositories.settings.set(ONBOARDING_KEYS.alertsSkipped, body.alertsSkipped)
      }
    })
    return send(c, onboardingStateSchema, readOnboarding(repositories))
  })

  return app
}
