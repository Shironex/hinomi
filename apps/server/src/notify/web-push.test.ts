import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
  type ECDH,
} from 'node:crypto'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { createNotifier } from './notifier.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'
import {
  PUSH_PLAINTEXT_MAX_BYTES,
  encryptPushPayload,
  pushMessage,
  parsePushKeys,
  pushHeaders,
  vapidKeys,
  vapidSubject,
  type PushKeys,
} from './web-push.js'

// Web push: the RFC 8291 encryption, the VAPID token and the web push channel. The browser side
// (decrypting a message) is written out here from the RFC, so the test does not trust the code
// it checks.

const ENDPOINT = 'https://push.example.dev/send/SECRET-subscription-0123456789'
const CLOCK = new Date('2026-11-06T10:00:00Z')

/** A browser's subscription: its key pair and auth secret. */
function browser(): { ecdh: ECDH; keys: PushKeys; secret: string } {
  const ecdh = createECDH('prime256v1')
  const p256dh = ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    keys: { p256dh, auth },
    secret: `${p256dh.toString('base64url')}.${auth.toString('base64url')}`,
  }
}

/** What the browser does with an aes128gcm push message (RFC 8291 section 3, RFC 8188). */
function decrypt(body: Buffer, receiver: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const senderPublic = body.subarray(21, 21 + idLength)
  const record = body.subarray(21 + idLength)
  const shared = receiver.ecdh.computeSecret(senderPublic)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    receiver.keys.p256dh,
    senderPublic,
  ])
  const ikm = Buffer.from(hkdfSync('sha256', shared, receiver.keys.auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ])
  expect(plain.at(-1)).toBe(2)
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

describe('encryption', () => {
  it('encrypts a message only the subscribed browser can read', () => {
    const receiver = browser()
    const body = encryptPushPayload(Buffer.from('{"title":"hello"}'), receiver.keys)
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(body.readUInt8(20)).toBe(65)
    expect(decrypt(body, receiver)).toBe('{"title":"hello"}')
    expect(() => decrypt(body, browser())).toThrow()
  })

  it('parses subscription keys and refuses malformed ones', () => {
    const { secret, keys } = browser()
    expect(parsePushKeys(secret)).toEqual(keys)
    expect(parsePushKeys('nope')).toBeNull()
    expect(parsePushKeys(`${keys.p256dh.toString('base64url')}.c2hvcnQ`)).toBeNull()
    expect(parsePushKeys(`${secret}.extra`)).toBeNull()
  })
})

describe('push message size', () => {
  it('cuts the JSON by bytes, multibyte text and long title and URL included', () => {
    const json = pushMessage({
      title: '火'.repeat(400),
      body: '日本語のテキスト🔥'.repeat(500),
      link: `https://hinomi.example.dev/finding/1?${'q'.repeat(3000)}`,
      urgency: 'max',
    })
    expect(json.length).toBeLessThanOrEqual(PUSH_PLAINTEXT_MAX_BYTES)
    const message = JSON.parse(json.toString('utf8')) as Record<string, string | null>
    expect(message.body?.endsWith('…')).toBe(true)
    expect(message.body).not.toContain('\uFFFD')
    expect(message.title?.length).toBeLessThanOrEqual(120)
    expect(message.url).toBeNull()
    // The whole encrypted body stays under the 4096 bytes push services take.
    expect(encryptPushPayload(json, browser().keys).length).toBeLessThanOrEqual(4096)
  })

  it('keeps a short message as it is', () => {
    const json = pushMessage({
      title: 'T',
      body: 'B',
      link: 'https://hinomi.example.dev/',
      urgency: 'low',
    })
    expect(JSON.parse(json.toString('utf8'))).toEqual({
      title: 'T',
      body: 'B',
      url: 'https://hinomi.example.dev/',
      tag: 'hinomi',
    })
  })
})

describe('VAPID', () => {
  it('signs a token for the push service origin that the public key verifies', () => {
    const box = createSecretBox(TEST_SECRET)
    const state = vapidKeys(repos.settings, box)
    if (state.kind !== 'ready') throw new Error('no keys')
    const vapid = state.keys
    const headers = pushHeaders(ENDPOINT, vapid, vapidSubject(null), 'max', CLOCK)
    expect(headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    })
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization ?? '')
    expect(match?.[2]).toBe(vapid.publicKey)
    const [head, claims, signature] = (match?.[1] ?? '').split('.')
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({
      aud: 'https://push.example.dev',
      exp: CLOCK.getTime() / 1000 + 12 * 60 * 60,
      sub: 'https://github.com/Shironex/hinomi',
    })
    const point = Buffer.from(vapid.publicKey, 'base64url')
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
    const ok = verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'),
    )
    expect(ok).toBe(true)
  })

  /** The public key of a ready state, or what went wrong. */
  const publicKeyOf = (state: ReturnType<typeof vapidKeys>) =>
    state.kind === 'ready' ? state.keys.publicKey : state.kind
  const storedVapid = () => repos.settings.get(NOTIFY_SETTING_KEYS.vapid, z.unknown())

  it('keeps one key pair with the private key encrypted', () => {
    const box = createSecretBox(TEST_SECRET)
    const first = vapidKeys(repos.settings, box)
    const second = vapidKeys(repos.settings, box)
    expect(first).toMatchObject({ kind: 'ready', rotated: false })
    expect(second).toMatchObject({ kind: 'ready', rotated: false })
    expect(publicKeyOf(second)).toBe(publicKeyOf(first))
    const stored = repos.settings.get(
      NOTIFY_SETTING_KEYS.vapid,
      z.object({ privateKeyEncrypted: z.boolean() }),
    )
    expect(stored?.privateKeyEncrypted).toBe(true)
  })

  it('replaces a key pair that no longer decrypts with the secret key, once', () => {
    const before = vapidKeys(repos.settings, createSecretBox(TEST_SECRET))
    const other = createSecretBox('another-secret-key-not-for-production')
    const after = vapidKeys(repos.settings, other)
    expect(after).toMatchObject({ kind: 'ready', rotated: true })
    expect(publicKeyOf(after)).not.toBe(publicKeyOf(before))
    const again = vapidKeys(repos.settings, other)
    expect(again).toMatchObject({ kind: 'ready', rotated: false })
    expect(publicKeyOf(again)).toBe(publicKeyOf(after))
  })

  it('leaves a sealed key pair alone while the secret key is missing', () => {
    const before = vapidKeys(repos.settings, createSecretBox(TEST_SECRET))
    const stored = storedVapid()
    expect(vapidKeys(repos.settings, null)).toEqual({ kind: 'secret-missing' })
    expect(vapidKeys(repos.settings, null)).toEqual({ kind: 'secret-missing' })
    expect(storedVapid()).toEqual(stored)
    // The secret key is back after the next restart: the same pair, nothing rotated.
    const back = vapidKeys(repos.settings, createSecretBox(TEST_SECRET))
    expect(back).toMatchObject({ kind: 'ready', rotated: false })
    expect(publicKeyOf(back)).toBe(publicKeyOf(before))
  })

  it('uses the public address as the subject only when it is https', () => {
    expect(vapidSubject('https://hinomi.example.dev')).toBe('https://hinomi.example.dev')
    expect(vapidSubject('http://hinomi.lan')).toBe('https://github.com/Shironex/hinomi')
  })
})

describe('web push channel', () => {
  interface Call {
    url: string
    headers: Record<string, string>
    body: Buffer
  }
  let calls: Call[]
  let status: number
  let onCall: () => void

  function notifier() {
    return createNotifier({
      repositories: repos,
      secretBox: createSecretBox(TEST_SECRET),
      fetch: () => Promise.reject(new Error('web push must use the public only fetch')),
      publicFetch: ((url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: Buffer.from(init?.body as Uint8Array),
        })
        onCall()
        return Promise.resolve(new Response(null, { status }))
      }) as typeof fetch,
      now: () => CLOCK,
      sleep: () => Promise.resolve(),
      delivery: { maxAttempts: 1 },
    })
  }

  beforeEach(() => {
    calls = []
    status = 201
    onCall = () => {}
  })

  /** The key a notifier hands to browsers. */
  const keyOf = (n: ReturnType<typeof notifier>) => {
    const key = n.webPushKey()
    if (!('publicKey' in key)) throw new Error(key.problem)
    return key.publicKey
  }

  it('stores a subscription, never shows its endpoint or keys, and sends an encrypted test', async () => {
    const n = notifier()
    const receiver = browser()
    expect(() =>
      n.channels.add({ kind: 'webpush', name: 'b', url: ENDPOINT, secret: 'bad' }),
    ).toThrow(/subscription keys/)
    expect(() =>
      n.channels.add({
        kind: 'webpush',
        name: 'b',
        url: 'http://push.example.dev/x',
        secret: receiver.secret,
      }),
    ).toThrow(/https/)
    const channel = n.channels.add({
      kind: 'webpush',
      name: 'Laptop',
      url: ENDPOINT,
      secret: receiver.secret,
    })
    expect(channel).toMatchObject({ secretSet: true, urlEncrypted: true, allowPrivate: false })
    expect(JSON.stringify(channel)).not.toContain('SECRET')
    expect(JSON.stringify(channel)).not.toContain(receiver.secret)

    expect(await n.sendTest(channel.id)).toEqual({ ok: true })
    expect(calls[0]?.url).toBe(ENDPOINT)
    expect(calls[0]?.headers.authorization).toMatch(/^vapid t=/)
    const message = JSON.parse(decrypt(calls[0]?.body ?? Buffer.alloc(0), receiver)) as Record<
      string,
      unknown
    >
    expect(message).toMatchObject({ title: 'Hinomi test message', tag: 'hinomi' })
    expect(String(message.body)).toContain('[HIGH] example-lib')
    expect(keyOf(n)).toBe(calls[0]?.headers.authorization?.split('k=')[1])
  })

  it('accepts a subscription made under the current key and refuses one under another', () => {
    const n = notifier()
    const receiver = browser()
    const added = n.channels.add({
      kind: 'webpush',
      name: 'Laptop',
      url: ENDPOINT,
      secret: `${receiver.secret}.${keyOf(n)}`,
    })
    expect(added.secretSet).toBe(true)
    const oldKey = Buffer.alloc(65, 4).toString('base64url')
    expect(() =>
      n.channels.add({
        kind: 'webpush',
        name: 'Old',
        url: ENDPOINT,
        secret: `${receiver.secret}.${oldKey}`,
      }),
    ).toThrow(/old web push key/)
    expect(() => n.channels.update(added.id, { secret: `${receiver.secret}.${oldKey}` })).toThrow(
      /old web push key/,
    )
  })

  it('refuses web push without touching the stored key while the secret key is missing', async () => {
    const key = keyOf(notifier())
    const stored = repos.settings.get(NOTIFY_SETTING_KEYS.vapid, z.unknown())
    const withoutKey = createNotifier({
      repositories: repos,
      fetch: () => Promise.reject(new Error('unused')),
      now: () => CLOCK,
    })
    expect(withoutKey.webPushKey()).toMatchObject({ code: 'secret_key_missing' })
    // A channel stored in clear (made without the secret key) fails with the reason.
    const { id } = withoutKey.channels.add({
      kind: 'webpush',
      name: 'Laptop',
      url: ENDPOINT,
      secret: browser().secret,
    })
    const result = await withoutKey.sendTest(id)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/HINOMI_SECRET_KEY is not set/)
    expect(calls).toHaveLength(0)
    expect(repos.settings.get(NOTIFY_SETTING_KEYS.vapid, z.unknown())).toEqual(stored)
    expect(keyOf(notifier())).toBe(key)
  })

  it('turns every web push channel off with the reason when the key had to be replaced', () => {
    const n = notifier()
    const { id } = n.channels.add({
      kind: 'webpush',
      name: 'Laptop',
      url: ENDPOINT,
      secret: browser().secret,
    })
    const oldKey = keyOf(n)
    const restarted = createNotifier({
      repositories: repos,
      secretBox: createSecretBox('another-secret-key-not-for-production'),
      fetch: () => Promise.reject(new Error('unused')),
      now: () => CLOCK,
    })
    const newKey = keyOf(restarted)
    expect(newKey).not.toBe(oldKey)
    const after = restarted.channels.get(id)
    expect(after?.enabled).toBe(false)
    expect(after?.disabledReason).toMatch(/web push key changed/)
    expect(keyOf(restarted)).toBe(newKey)
    expect(restarted.channels.update(id, { enabled: true }).disabledReason).toBeUndefined()
  })

  it('keeps the channels a key replacement turned off when it happens during an edit', () => {
    const n = notifier()
    const add = (name: string) =>
      n.channels.add({ kind: 'webpush', name, url: ENDPOINT, secret: browser().secret }).id
    const edited = add('Laptop')
    const other = add('Phone')
    keyOf(n)
    const restarted = createNotifier({
      repositories: repos,
      secretBox: createSecretBox('another-secret-key-not-for-production'),
      fetch: () => Promise.reject(new Error('unused')),
      now: () => CLOCK,
    })
    // The new subscription is checked against the key, which is replaced right then.
    const view = restarted.channels.update(edited, { secret: browser().secret, name: 'Laptop 2' })
    expect(view).toMatchObject({ name: 'Laptop 2', enabled: false })
    expect(view.disabledReason).toMatch(/web push key changed/)
    const untouched = restarted.channels.get(other)
    expect(untouched?.enabled).toBe(false)
    expect(untouched?.disabledReason).toMatch(/web push key changed/)
  })

  it('goes on with the other channels when one is removed while it is sent to', async () => {
    const n = notifier()
    const { id } = n.channels.add({
      kind: 'webpush',
      name: 'Laptop',
      url: ENDPOINT,
      secret: browser().secret,
    })
    status = 410
    onCall = () => n.channels.remove(id)
    await expect(n.sendTest(id)).resolves.toMatchObject({ ok: false })
    expect(n.channels.get(id)).toBeUndefined()
  })

  it.each([403, 404, 410])(
    'turns the channel off when the push service answers %i',
    async (code) => {
      const n = notifier()
      const { id } = n.channels.add({
        kind: 'webpush',
        name: 'Laptop',
        url: ENDPOINT,
        secret: browser().secret,
      })
      status = code
      expect((await n.sendTest(id)).ok).toBe(false)
      const after = n.channels.get(id)
      expect(after?.enabled).toBe(false)
      expect(after?.disabledReason).toMatch(/no longer subscribed/)
    },
  )
})
