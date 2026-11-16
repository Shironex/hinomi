import { notifyChannelsResponseSchema } from '@hinomi/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectNotifier, startDigestTimer } from '../scheduler/index.js'
import { createTestApi, seedWorld } from './testing.js'

const DISCORD_URL =
  'https://discord.com/api/webhooks/1234567890/SECRETfictionalTOKENabcdefghijklmnop0123'
const HOOK_URL = 'https://hooks.example.dev/in/SECRET-PATH-fictional-0123456789'

function errorOf(json: unknown) {
  return (json as { error: { code: string; message: string } }).error
}

describe('notification channels', () => {
  it('adds, lists, updates and removes channels with the URL always masked', async () => {
    const { call, logger } = createTestApi()
    const created = await call('POST', '/notifications/channels', {
      kind: 'discord',
      name: 'ops',
      url: DISCORD_URL,
      minSeverity: 'high',
    })
    expect(created.status).toBe(201)
    expect(created.text).not.toContain('SECRET')
    expect(created.json).toMatchObject({ kind: 'discord', urlEncrypted: true, minSeverity: 'high' })
    const id = (created.json as { id: string }).id

    const list = await call('GET', '/notifications/channels')
    expect(notifyChannelsResponseSchema.parse(list.json).items).toHaveLength(1)
    expect(list.text).not.toContain('SECRET')

    const updated = await call('PATCH', `/notifications/channels/${id}`, {
      url: `${DISCORD_URL}9`,
      enabled: false,
    })
    expect(updated.status).toBe(200)
    expect(updated.json).toMatchObject({ enabled: false })
    expect(updated.text).not.toContain('SECRET')

    expect((await call('DELETE', `/notifications/channels/${id}`)).status).toBe(204)
    expect((await call('DELETE', `/notifications/channels/${id}`)).status).toBe(404)
    expect(logger.text()).not.toContain('SECRET')
  })

  it('rejects bad input without echoing the URL', async () => {
    const { call } = createTestApi()
    const wrongHost = await call('POST', '/notifications/channels', {
      kind: 'discord',
      name: 'ops',
      url: HOOK_URL,
    })
    expect(wrongHost.status).toBe(400)
    expect(wrongHost.text).not.toContain('SECRET')
    const extra = await call('POST', '/notifications/channels', {
      kind: 'webhook',
      name: 'ops',
      url: HOOK_URL,
      headers: {},
    })
    expect(extra.status).toBe(400)
    expect(errorOf(extra.json).code).toBe('validation_failed')
    const missing = await call('PATCH', '/notifications/channels/not-a-uuid', { enabled: true })
    expect(missing.status).toBe(404)
  })

  it('sends a test message and answers 404 for an unknown channel', async () => {
    const { call, deliveries, deliveryStatus } = createTestApi()
    const created = await call('POST', '/notifications/channels', {
      kind: 'webhook',
      name: 'hook',
      url: HOOK_URL,
    })
    const id = (created.json as { id: string }).id
    const ok = await call('POST', `/notifications/channels/${id}/test`)
    expect(ok.json).toEqual({ ok: true })
    expect(deliveries.map((d) => d.url)).toEqual([HOOK_URL])

    deliveryStatus.code = 400
    const failed = await call('POST', `/notifications/channels/${id}/test`)
    expect(failed.status).toBe(200)
    expect((failed.json as { ok: boolean }).ok).toBe(false)
    expect(failed.text).not.toContain('SECRET')

    const unknown = await call(
      'POST',
      '/notifications/channels/00000000-0000-4000-8000-000000000000/test',
    )
    expect(unknown.status).toBe(404)
  })
})

describe('notification settings', () => {
  it('reads and writes the public URL and digest hour, replanning the digest', async () => {
    const { call, onDigestHourChanged } = createTestApi()
    expect((await call('GET', '/notifications/settings')).json).toEqual({
      publicBaseUrl: null,
      digestHour: 8,
      fixRunEvents: {
        prOpened: true,
        checksFailing: true,
        verified: true,
        notCleared: true,
        failed: true,
        warnings: true,
      },
    })
    expect((await call('PATCH', '/notifications/settings', { digestHour: 24 })).status).toBe(400)
    expect(
      (await call('PATCH', '/notifications/settings', { publicBaseUrl: 'ftp://x.example.dev' }))
        .status,
    ).toBe(400)
    const updated = await call('PATCH', '/notifications/settings', {
      publicBaseUrl: 'https://hinomi.example.dev/',
      digestHour: 18,
    })
    expect(updated.json).toMatchObject({
      publicBaseUrl: 'https://hinomi.example.dev',
      digestHour: 18,
    })
    expect(onDigestHourChanged).toHaveBeenCalledTimes(1)
    const cleared = await call('PATCH', '/notifications/settings', { publicBaseUrl: '' })
    expect(cleared.json).toMatchObject({ publicBaseUrl: null })
  })
})

describe('fix run event settings', () => {
  it('switches single events and keeps the others', async () => {
    const { call, onDigestHourChanged } = createTestApi()
    const off = await call('PATCH', '/notifications/settings', {
      fixRunEvents: { warnings: false, verified: false },
    })
    expect(off.status).toBe(200)
    expect(off.json).toMatchObject({
      fixRunEvents: {
        prOpened: true,
        checksFailing: true,
        verified: false,
        notCleared: true,
        failed: true,
        warnings: false,
      },
    })
    const back = await call('PATCH', '/notifications/settings', {
      fixRunEvents: { verified: true },
    })
    expect((back.json as { fixRunEvents: Record<string, boolean> }).fixRunEvents).toMatchObject({
      verified: true,
      warnings: false,
    })
    expect((await call('GET', '/notifications/settings')).json).toMatchObject({
      fixRunEvents: { verified: true, warnings: false },
    })
    expect(onDigestHourChanged).not.toHaveBeenCalled()
  })

  it('refuses unknown events, other types and an empty change', async () => {
    const { call } = createTestApi()
    for (const fixRunEvents of [{ merged: true }, { failed: 'no' }, {}]) {
      expect((await call('PATCH', '/notifications/settings', { fixRunEvents })).status).toBe(400)
    }
  })
})

describe('notifier wiring', () => {
  it('hands every finished scan to the notifier', async () => {
    const { scheduler, scan } = createTestApi()
    const handleScanFinished = vi.fn(() => Promise.resolve())
    connectNotifier(scheduler, { handleScanFinished })
    const { run } = scheduler.scanNow()
    scan.finish()
    await scheduler.idle()
    expect(handleScanFinished).toHaveBeenCalledWith(
      expect.objectContaining({ scanRunId: run.id, status: 'succeeded' }),
    )
  })

  it('delivers an immediate message for a new exposed finding after a scan', async () => {
    const { call, repos, scheduler, scan, notifier, deliveries } = createTestApi()
    const world = seedWorld(repos)
    await call('POST', '/notifications/channels', { kind: 'webhook', name: 'hook', url: HOOK_URL })
    connectNotifier(scheduler, notifier)
    scan.nextChanges = [{ findingId: world.critical.id, change: 'opened' }]
    scheduler.scanNow()
    scan.finish()
    await scheduler.idle()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.body).toContain('left-pad-ng')
  })

  it('sends the digest at the configured hour and plans the next one', async () => {
    const { repos } = createTestApi()
    repos.settings.set('notify.digestHour', 9)
    let clock = new Date(2026, 10, 6, 7, 30)
    const timers: { fn: () => void; ms: number }[] = []
    const sendDigest = vi.fn(() => Promise.resolve())
    const digest = startDigestTimer({
      notifier: { sendDigest },
      settings: repos.settings,
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer = { fn, ms }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
    })
    expect(timers[0]?.ms).toBe(90 * 60_000)
    expect(digest.nextAt()).toEqual(new Date(2026, 10, 6, 9, 0))

    clock = new Date(2026, 10, 6, 9, 0)
    timers[0]!.fn()
    await vi.waitFor(() => expect(timers).toHaveLength(2))
    expect(sendDigest).toHaveBeenCalledTimes(1)
    expect(timers[1]?.ms).toBe(24 * 60 * 60_000)

    digest.stop()
    expect(digest.nextAt()).toBeNull()
  })
})

describe('email channels', () => {
  const email = {
    host: 'smtp.example.dev',
    port: 587,
    security: 'starttls',
    user: 'hinomi@example.dev',
    password: 'smtp-SECRET-pass-0123',
    from: 'hinomi@example.dev',
    to: ['ops@example.dev'],
  }

  it('shows host, port, from, to and "password set", never the password', async () => {
    const { call, logger } = createTestApi()
    const created = await call('POST', '/notifications/channels', {
      kind: 'email',
      name: 'mail',
      email,
    })
    expect(created.status).toBe(201)
    expect(created.text).not.toContain('SECRET')
    expect(created.json).toMatchObject({
      kind: 'email',
      url: 'smtp.example.dev:587',
      email: {
        host: 'smtp.example.dev',
        port: 587,
        from: 'hinomi@example.dev',
        to: ['ops@example.dev'],
        passwordSet: true,
      },
    })
    const id = (created.json as { id: string }).id

    const patched = await call('PATCH', `/notifications/channels/${id}`, {
      email: { to: ['ops@example.dev', 'oncall@example.dev'] },
    })
    expect(patched.status).toBe(200)
    expect(patched.text).not.toContain('SECRET')
    expect(patched.json).toMatchObject({ email: { passwordSet: true } })

    const list = await call('GET', '/notifications/channels')
    expect(notifyChannelsResponseSchema.parse(list.json).items).toHaveLength(1)
    expect(list.text).not.toContain('SECRET')
    expect(logger.text()).not.toContain('SECRET')
  })

  it('rejects settings that do not fit', async () => {
    const { call } = createTestApi()
    const post = (body: unknown) => call('POST', '/notifications/channels', body)
    expect((await post({ kind: 'email', name: 'mail' })).status).toBe(400)
    expect(
      (await post({ kind: 'email', name: 'mail', url: 'https://hooks.example.dev/x', email }))
        .status,
    ).toBe(400)
    expect(
      (await post({ kind: 'webhook', name: 'hook', url: 'https://hooks.example.dev/x', email }))
        .status,
    ).toBe(400)
    expect((await post({ kind: 'email', name: 'mail', email: { ...email, to: [] } })).status).toBe(
      400,
    )
    expect(
      (await post({ kind: 'email', name: 'mail', email: { ...email, to: ['not an address'] } }))
        .status,
    ).toBe(400)
    expect(
      (await post({ kind: 'email', name: 'mail', email: { ...email, port: 70000 } })).status,
    ).toBe(400)
    expect(
      (await post({ kind: 'email', name: 'mail', email: { ...email, host: 'a b' } })).status,
    ).toBe(400)
    expect(
      (
        await post({
          kind: 'email',
          name: 'mail',
          email: { ...email, from: 'a@example.dev\r\nBcc: x@example.dev' },
        })
      ).status,
    ).toBe(400)
  })

  it('sends a test email and reports a failed login without the password', async () => {
    const { call, mails, mailFailure } = createTestApi()
    const created = await call('POST', '/notifications/channels', {
      kind: 'email',
      name: 'mail',
      email,
    })
    const id = (created.json as { id: string }).id
    expect((await call('POST', `/notifications/channels/${id}/test`)).json).toEqual({ ok: true })
    expect(mails).toHaveLength(1)
    expect(mails[0]?.message.to).toEqual(['ops@example.dev'])

    mailFailure.message = 'Invalid login'
    const failed = await call('POST', `/notifications/channels/${id}/test`)
    expect(failed.json).toEqual({ ok: false, error: 'Invalid login' })
    expect(failed.text).not.toContain('SECRET')
  })
})

describe('Slack, ntfy, Gotify and Telegram channels', () => {
  // Fake secrets, built from parts so no literal in the source looks like a real one.
  const NTFY_TOKEN = ['tk', 'SECRETfakeNTFY'].join('_')
  const BOT_TOKEN = ['42', `fake_SECRET_bot_${'x'.repeat(10)}`].join(':')

  it('stores the token, shows only that one is set, and lets it be replaced', async () => {
    const { call, logger } = createTestApi()
    const created = await call('POST', '/notifications/channels', {
      kind: 'ntfy',
      name: 'phone',
      url: 'https://ntfy.example.dev/hinomi-SECRET-topic',
      secret: NTFY_TOKEN,
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ kind: 'ntfy', secretSet: true, allowPrivate: false })
    expect(created.text).not.toContain('SECRET')
    const id = (created.json as { id: string }).id
    const cleared = await call('PATCH', `/notifications/channels/${id}`, { secret: '' })
    expect(cleared.json).toMatchObject({ secretSet: false })

    const telegram = await call('POST', '/notifications/channels', {
      kind: 'telegram',
      name: 'ops chat',
      secret: BOT_TOKEN,
      chatId: '-1001234567890',
    })
    expect(telegram.status).toBe(201)
    expect(telegram.json).toMatchObject({ chatId: '-1001234567890', secretSet: true })
    expect(telegram.text).not.toContain('SECRET')
    expect(logger.text()).not.toContain('SECRET')
  })

  it('rejects what a kind does not take, and private addresses unless allowed', async () => {
    const { call } = createTestApi()
    const post = (body: Record<string, unknown>) => call('POST', '/notifications/channels', body)
    expect((await post({ kind: 'telegram', name: 't', secret: BOT_TOKEN })).status).toBe(400)
    expect(
      (await post({ kind: 'gotify', name: 'g', url: 'https://gotify.example.dev' })).status,
    ).toBe(400)
    expect(
      (
        await post({
          kind: 'slack',
          name: 's',
          url: 'https://hooks.slack.com/services/x',
          secret: 'x',
        })
      ).status,
    ).toBe(400)
    const metadata = await post({
      kind: 'webhook',
      name: 'w',
      url: 'http://169.254.169.254/latest/meta-data',
    })
    expect(metadata.status).toBe(400)
    expect(errorOf(metadata.json).message).toMatch(/private/)
    const allowed = await post({
      kind: 'webhook',
      name: 'w',
      url: 'http://10.0.0.8:8080/hook',
      allowPrivate: true,
    })
    expect(allowed.status).toBe(201)
    expect(allowed.json).toMatchObject({ allowPrivate: true })
  })
})

describe('web push key', () => {
  it('hands out one VAPID public key, made on first use', async () => {
    const { call } = createTestApi()
    const first = await call('GET', '/notifications/push-key')
    expect(first.status).toBe(200)
    const { publicKey } = first.json as { publicKey: string }
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65)
    expect((await call('GET', '/notifications/push-key')).json).toEqual({ publicKey })
  })

  it('answers 409 secret_key_missing for a sealed key without HINOMI_SECRET_KEY, and keeps it', async () => {
    const { call, repos } = createTestApi({ withSecret: false })
    const sealed = {
      publicKey: 'BPub',
      x: 'x',
      y: 'y',
      privateKey: 'v1:sealed',
      privateKeyEncrypted: true,
    }
    repos.settings.set('notify.vapid', sealed)
    const answer = await call('GET', '/notifications/push-key')
    expect(answer.status).toBe(409)
    const { error } = answer.json as { error: { code: string; message: string } }
    expect(error.code).toBe('secret_key_missing')
    expect(error.message).toMatch(/HINOMI_SECRET_KEY/)
    expect(repos.settings.get('notify.vapid', z.unknown())).toEqual(sealed)
  })
})
