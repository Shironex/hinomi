import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import { z } from 'zod'
import type { SecretBox } from '../crypto/secret-box.js'
import type { SettingsRepository } from '../repository/index.js'
import type { PushText, Urgency } from './chat-format.js'
import { NOTIFY_SETTING_KEYS } from './settings.js'

// Web push to the installed app (the PWA), with no push library: the message is encrypted for
// the browser with RFC 8291 (aes128gcm, RFC 8188) and the request carries a VAPID token
// (RFC 8292) signed with this instance's key pair, made on first use and kept in settings with
// the private key sealed like every other secret.

/** The VAPID key pair as stored. `privateKey` is the JWK `d`, ciphertext when encrypted. */
const storedVapidSchema = z.object({
  publicKey: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
  privateKey: z.string().min(1),
  privateKeyEncrypted: z.boolean(),
})
type StoredVapid = z.infer<typeof storedVapidSchema>

/** A subscription's keys: the browser's P-256 public key (65 bytes) and auth secret (16 bytes). */
export interface PushKeys {
  p256dh: Buffer
  auth: Buffer
}

const B64URL = /^[A-Za-z0-9_-]+$/

/**
 * Parses the secret of a web push channel, `<p256dh>.<auth>` in base64url as the browser's
 * PushSubscription.toJSON() gives them. Null when either is malformed.
 */
/**
 * A subscription as the settings page sends it: `<p256dh>.<auth>` and, optionally, the
 * `.<applicationServerKey>` it was made under, so one made under a replaced key is refused.
 */
export function splitSubscription(secret: string): { keys: string; serverKey: string | null } {
  const parts = secret.split('.')
  if (parts.length !== 3) return { keys: secret, serverKey: null }
  return { keys: `${parts[0]}.${parts[1]}`, serverKey: parts[2] ?? null }
}

export function parsePushKeys(secret: string): PushKeys | null {
  const [p256dh, auth, extra] = secret.split('.')
  if (!p256dh || !auth || extra !== undefined || !B64URL.test(p256dh) || !B64URL.test(auth)) {
    return null
  }
  const keys = { p256dh: Buffer.from(p256dh, 'base64url'), auth: Buffer.from(auth, 'base64url') }
  return keys.p256dh.length === 65 && keys.p256dh[0] === 4 && keys.auth.length === 16 ? keys : null
}

/**
 * Longest JSON a push message may be. Push services take 4096 bytes of encrypted body: 86 bytes
 * of header, 16 of tag and 1 of padding leave 3993, and some services count less generously.
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 3000
const PUSH_TITLE_MAX = 120
const PUSH_URL_MAX_BYTES = 1000

/** Cuts text to at most `max` UTF-8 bytes on a character boundary, with an ellipsis when cut. */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  let size = 0
  const room = max - Buffer.byteLength('…')
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (size + bytes > room) break
    out += char
    size += bytes
  }
  return `${out}…`
}

/**
 * The JSON the service worker shows (`{ title, body, url, tag }`), cut by bytes after encoding so
 * the encrypted message fits: a long title is shortened, an over long URL is left out, and the
 * body takes what room is left.
 */
export function pushMessage(text: PushText): Buffer {
  const title =
    text.title.length > PUSH_TITLE_MAX ? `${text.title.slice(0, PUSH_TITLE_MAX - 1)}…` : text.title
  const url = text.link && Buffer.byteLength(text.link) <= PUSH_URL_MAX_BYTES ? text.link : null
  const encode = (body: string) => Buffer.from(JSON.stringify({ title, body, url, tag: 'hinomi' }))
  const full = encode(text.body)
  if (full.length <= PUSH_PLAINTEXT_MAX_BYTES) return full
  // JSON escaping can make a character longer than its UTF-8 bytes: shrink until it fits.
  let room = PUSH_PLAINTEXT_MAX_BYTES - encode('').length
  for (;;) {
    const json = encode(cutBytes(text.body, Math.max(room, 0)))
    if (json.length <= PUSH_PLAINTEXT_MAX_BYTES || room <= 0) return json
    room -= json.length - PUSH_PLAINTEXT_MAX_BYTES
  }
}

/** Record size of the one record a message is: anything above the message length works. */
const RECORD_SIZE = 4096

/**
 * Encrypts a push message for one browser (RFC 8291). Returns the aes128gcm body: salt, record
 * size and the sender's ephemeral public key, then the one encrypted record.
 */
export function encryptPushPayload(plaintext: Uint8Array, keys: PushKeys): Buffer {
  const sender = createECDH('prime256v1')
  const senderPublic = sender.generateKeys()
  const shared = sender.computeSecret(keys.p256dh)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.p256dh, senderPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, keyInfo, 32))
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record.
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(senderPublic.length, 20)
  return Buffer.concat([header, senderPublic, record])
}

/** How long a push service keeps a message for an offline browser, in seconds. */
const PUSH_TTL_SECONDS = 24 * 60 * 60
/** VAPID tokens may live at most 24 hours; 12 leaves room for clock skew. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

const PUSH_URGENCY: Record<Urgency, string> = {
  max: 'high',
  high: 'high',
  default: 'normal',
  low: 'low',
}

/** The VAPID key pair in use. */
export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: the browser's applicationServerKey. */
  publicKey: string
  privateKey: KeyObject
}

/** A JWT signed with ES256 (raw r and s, as JOSE wants them). */
function signJwt(claims: Record<string, unknown>, key: KeyObject): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' })
  return `${unsigned}.${signature.toString('base64url')}`
}

/**
 * The headers of one push request: the VAPID authorization for the push service's origin, how
 * long it may keep the message and how urgent it is.
 */
export function pushHeaders(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  urgency: Urgency,
  now: Date,
): Record<string, string> {
  const token = signJwt(
    {
      aud: new URL(endpoint).origin,
      exp: Math.floor(now.getTime() / 1000) + VAPID_LIFETIME_SECONDS,
      sub: subject,
    },
    vapid.privateKey,
  )
  return {
    authorization: `vapid t=${token}, k=${vapid.publicKey}`,
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(PUSH_TTL_SECONDS),
    urgency: PUSH_URGENCY[urgency],
  }
}

/**
 * The VAPID `sub`: whom the push service may contact. The public address of this Hinomi when it
 * is https, else the project page (Apple refuses anything but an https or mailto URL).
 */
export function vapidSubject(publicBaseUrl: string | null): string {
  return publicBaseUrl?.startsWith('https://')
    ? publicBaseUrl
    : 'https://github.com/Shironex/hinomi'
}

/** Makes a new VAPID key pair and stores it, the private key sealed when a secret key is set. */
function createVapid(
  settings: SettingsRepository,
  secretBox: SecretBox | null,
): StoredVapid | null {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  if (!jwk.d || !jwk.x || !jwk.y) return null
  const sealed = secretBox
    ? { privateKey: secretBox.encrypt(jwk.d), privateKeyEncrypted: true }
    : { privateKey: jwk.d, privateKeyEncrypted: false }
  const stored = { publicKey: publicKeyOf(jwk.x, jwk.y), x: jwk.x, y: jwk.y, ...sealed }
  settings.set(NOTIFY_SETTING_KEYS.vapid, stored)
  return stored
}

/** What reading the VAPID key pair gave. */
export type VapidState =
  | { kind: 'ready'; keys: VapidKeys; rotated: boolean }
  /** The private key is sealed but HINOMI_SECRET_KEY is not set: nothing was changed. */
  | { kind: 'secret-missing' }
  /** No key pair could be made or read. */
  | { kind: 'unavailable' }

/**
 * Reads this instance's VAPID key pair, making and storing one on first use. Only when a secret
 * key is set and the stored private key does not decrypt with it (HINOMI_SECRET_KEY changed) is
 * a new pair made in its place, with `rotated` true: every browser subscribed under the old key
 * must subscribe again, and the caller turns their channels off. A sealed key with no secret key
 * set is left alone (the key may be back after the next restart).
 */
export function vapidKeys(settings: SettingsRepository, secretBox: SecretBox | null): VapidState {
  const stored = settings.get(NOTIFY_SETTING_KEYS.vapid, storedVapidSchema)
  if (stored?.privateKeyEncrypted && !secretBox) return { kind: 'secret-missing' }
  if (stored) {
    const opened = openVapid(stored, secretBox)
    if (opened) return { kind: 'ready', keys: opened, rotated: false }
    if (!stored.privateKeyEncrypted) return { kind: 'unavailable' }
  }
  const created = createVapid(settings, secretBox)
  const keys = created && openVapid(created, secretBox)
  return keys ? { kind: 'ready', keys, rotated: stored !== undefined } : { kind: 'unavailable' }
}

function publicKeyOf(x: string, y: string): string {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x, 'base64url'),
    Buffer.from(y, 'base64url'),
  ]).toString('base64url')
}

function openVapid(stored: StoredVapid, secretBox: SecretBox | null): VapidKeys | null {
  let d = stored.privateKey
  if (stored.privateKeyEncrypted) {
    if (!secretBox) return null
    try {
      d = secretBox.decrypt(stored.privateKey)
    } catch {
      return null
    }
  }
  try {
    const privateKey = createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d, x: stored.x, y: stored.y },
      format: 'jwk',
    })
    return { publicKey: stored.publicKey, privateKey }
  } catch {
    return null
  }
}
