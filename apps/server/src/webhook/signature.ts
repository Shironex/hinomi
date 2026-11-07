import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// The X-Hub-Signature-256 check: HMAC SHA-256 of the raw body with the webhook secret, compared
// in constant time. See https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i

/** Bytes of a new secret: 256 bits, written as 43 base64url characters. */
const SECRET_BYTES = 32

/** The header value GitHub sends for `body` signed with `secret`. */
export function signGithubPayload(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/**
 * True when `header` is the signature of `body` under `secret`. A missing or malformed header is
 * false; the digests are compared with timingSafeEqual, both 32 bytes by construction.
 */
export function verifyGithubSignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean {
  const match = SIGNATURE.exec(header?.trim() ?? '')
  if (!match?.[1]) return false
  const sent = Buffer.from(match[1], 'hex')
  const expected = createHmac('sha256', secret).update(body).digest()
  return sent.length === expected.length && timingSafeEqual(sent, expected)
}

/** A new random webhook secret. */
export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

// The webhook runner's signature, in both directions: `t=<unix seconds>,v1=<hex>` where v1 is
// HMAC SHA-256 of `<t>.<raw body>`. The timestamp is signed too, so an old delivery cannot be
// replayed with a fresh one.

const RUNNER_SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/i

function runnerDigest(secret: string, timestamp: number, body: Uint8Array | string): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest()
}

/** The X-Hinomi-Signature value for `body` sent at `at`. */
export function signRunnerPayload(secret: string, body: Uint8Array | string, at: Date): string {
  const timestamp = Math.floor(at.getTime() / 1000)
  return `t=${timestamp},v1=${runnerDigest(secret, timestamp, body).toString('hex')}`
}

export type RunnerSignatureCheck = { ok: true } | { ok: false; reason: 'invalid' | 'expired' }

/**
 * Checks an X-Hinomi-Signature header: the HMAC over the timestamp and the raw body, compared in
 * constant time, then the timestamp within `toleranceSeconds` of `now`.
 */
export function verifyRunnerSignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number,
): RunnerSignatureCheck {
  const match = RUNNER_SIGNATURE.exec(header?.trim() ?? '')
  if (!match?.[1] || !match[2]) return { ok: false, reason: 'invalid' }
  const timestamp = Number(match[1])
  const sent = Buffer.from(match[2], 'hex')
  const expected = runnerDigest(secret, timestamp, body)
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
    return { ok: false, reason: 'invalid' }
  }
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true }
}
