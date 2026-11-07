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
