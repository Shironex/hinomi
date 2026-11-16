import {
  channelParamSchema,
  createNotifyChannelRequestSchema,
  notifyChannelSchema,
  notifyChannelsResponseSchema,
  notifyChannelTestResultSchema,
  notifySettingsSchema,
  updateNotifyChannelRequestSchema,
  updateNotifySettingsRequestSchema,
  webPushKeySchema,
} from '@hinomi/shared'
import { Hono } from 'hono'
import {
  ChannelNotFoundError,
  ChannelValidationError,
  readNotifySettings,
  writeDigestHour,
  writeFixRunEvents,
  writePublicBaseUrl,
  type Notifier,
} from '../../notify/index.js'
import type { ApiDeps } from '../deps.js'
import { HttpError, notFound, readJson, readParams, send } from '../http.js'

export interface NotificationsApiOptions {
  notifier: Notifier
  /** Called after the digest hour changes, to plan the digest timer again. */
  onDigestHourChanged?: () => void
}

/** Channel store errors to HTTP errors. Their messages never contain the webhook URL. */
function channelCall<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof ChannelNotFoundError) throw notFound('Channel')
    if (error instanceof ChannelValidationError) {
      throw new HttpError(400, 'validation_failed', error.message, { cause: error })
    }
    throw error
  }
}

export function notificationsRoutes(deps: ApiDeps, options: NotificationsApiOptions) {
  const app = new Hono()
  const { notifier } = options
  const { settings } = deps.repositories

  app.get('/channels', (c) =>
    send(c, notifyChannelsResponseSchema, { items: notifier.channels.list() }),
  )

  app.post('/channels', async (c) => {
    const body = await readJson(c, createNotifyChannelRequestSchema)
    const channel = channelCall(() => notifier.channels.add(body))
    return send(c, notifyChannelSchema, channel, 201)
  })

  app.patch('/channels/:id', async (c) => {
    const { id } = readParams(c, channelParamSchema)
    const body = await readJson(c, updateNotifyChannelRequestSchema)
    const channel = channelCall(() => notifier.channels.update(id, body))
    return send(c, notifyChannelSchema, channel)
  })

  app.delete('/channels/:id', (c) => {
    const { id } = readParams(c, channelParamSchema)
    if (!notifier.channels.remove(id)) throw notFound('Channel')
    return c.body(null, 204)
  })

  /** Sends a test message through the channel. A failed delivery is a 200 with ok: false. */
  app.post('/channels/:id/test', async (c) => {
    const { id } = readParams(c, channelParamSchema)
    try {
      const result = await notifier.sendTest(id)
      return send(c, notifyChannelTestResultSchema, result)
    } catch (error) {
      if (error instanceof ChannelNotFoundError) throw notFound('Channel')
      throw error
    }
  })

  /** The VAPID public key a browser subscribes to web push with. Made on first use; 409 without the secret key that opens it. */
  app.get('/push-key', (c) => {
    const key = notifier.webPushKey()
    if ('problem' in key) {
      // A missing secret key leaves the stored key alone: it can be read again once it is set.
      throw new HttpError(
        409,
        key.code === 'secret_key_missing' ? key.code : 'conflict',
        key.problem,
      )
    }
    return send(c, webPushKeySchema, { publicKey: key.publicKey })
  })

  app.get('/settings', (c) => send(c, notifySettingsSchema, readNotifySettings(settings)))

  app.patch('/settings', async (c) => {
    const body = await readJson(c, updateNotifySettingsRequestSchema)
    deps.repositories.db.transaction(() => {
      if (body.publicBaseUrl !== undefined) writePublicBaseUrl(settings, body.publicBaseUrl)
      if (body.digestHour !== undefined) writeDigestHour(settings, body.digestHour)
      if (body.fixRunEvents !== undefined) writeFixRunEvents(settings, body.fixRunEvents)
    })
    if (body.digestHour !== undefined) options.onDigestHourChanged?.()
    return send(c, notifySettingsSchema, readNotifySettings(settings))
  })

  return app
}
