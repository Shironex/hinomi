import { onboardingStateSchema, updateOnboardingRequestSchema } from '@hinomi/shared'
import { Hono } from 'hono'
import { ONBOARDING_KEYS, readOnboarding } from '../../repository/index.js'
import type { ApiDeps } from '../deps.js'
import { readJson, send } from '../http.js'

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
