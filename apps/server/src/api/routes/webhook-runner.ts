import {
  rotateWebhookRunnerSecretResponseSchema,
  updateWebhookRunnerRequestSchema,
  webhookRunnerSettingsSchema,
} from '@hinomi/shared'
import { Hono } from 'hono'
import { checkRunnerUrl, type RunnerCallbackReceiver } from '../../webhook/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, readJson, send } from '../http.js'

/**
 * Settings of the webhook runner, under /api/settings/webhook-runner. As private as the rest
 * of the API; only the callback path is meant to be exposed.
 */
export function webhookRunnerSettingsRoutes(deps: ApiDeps, receiver: RunnerCallbackReceiver) {
  const app = new Hono()

  app.get('/', (c) => send(c, webhookRunnerSettingsSchema, receiver.view()))

  app.patch('/', async (c) => {
    const body = await readJson(c, updateWebhookRunnerRequestSchema)
    const current = receiver.settings.read()
    const url = body.url === undefined ? current.url : body.url
    const allowPrivate = body.allowPrivate ?? current.allowPrivate
    // A URL is checked against the switch it will be used with, so turning private addresses
    // off with a private URL stored is refused too.
    if (url) {
      const checked = checkRunnerUrl(url, allowPrivate)
      if (!checked.ok) throw new HttpError(422, 'validation_failed', checked.message)
    }
    receiver.settings.update(body)
    deps.log.info('runner: webhook runner settings changed', {
      urlSet: url !== null,
      allowPrivate,
      callbackUrlSet:
        (body.callbackUrl === undefined ? current.callbackUrl : body.callbackUrl) !== null,
    })
    return send(c, webhookRunnerSettingsSchema, receiver.view())
  })

  /** Makes a new secret and shows it once. Callbacks signed with the old one fail from now on. */
  app.post('/secret', (c) => {
    const secret = receiver.settings.rotate(deps.now())
    deps.log.info('runner: webhook runner secret rotated')
    c.header('cache-control', 'no-store')
    return send(
      c,
      rotateWebhookRunnerSecretResponseSchema,
      { secret, settings: receiver.view() },
      201,
    )
  })

  return app
}
