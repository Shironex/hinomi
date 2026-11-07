import {
  githubWebhookSettingsSchema,
  rotateGithubWebhookSecretResponseSchema,
  updateGithubWebhookRequestSchema,
} from '@hinomi/shared'
import { Hono } from 'hono'
import type { GithubWebhookReceiver } from '../../webhook/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, readJson, send } from '../http.js'

/**
 * Settings of the optional GitHub webhook, under /api/settings/github-webhook. These routes are
 * as private as the rest of the API; only the receiver path is meant to be exposed.
 */
export function githubWebhookSettingsRoutes(deps: ApiDeps, receiver: GithubWebhookReceiver) {
  const app = new Hono()

  app.get('/', (c) => send(c, githubWebhookSettingsSchema, receiver.view()))

  app.patch('/', async (c) => {
    const body = await readJson(c, updateGithubWebhookRequestSchema)
    if (body.enabled === true && !receiver.settings.read().secretSet) {
      throw new HttpError(
        409,
        'conflict',
        'Generate a webhook secret before turning the webhook on',
      )
    }
    receiver.settings.update(body)
    return send(c, githubWebhookSettingsSchema, receiver.view())
  })

  /** Makes a new secret and shows it once. Deliveries signed with the old one fail from now on. */
  app.post('/secret', (c) => {
    const secret = receiver.settings.rotate(deps.now())
    c.header('cache-control', 'no-store')
    return send(
      c,
      rotateGithubWebhookSecretResponseSchema,
      { secret, settings: receiver.view() },
      201,
    )
  })

  return app
}
