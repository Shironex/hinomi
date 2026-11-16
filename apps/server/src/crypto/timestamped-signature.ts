import { createHmac } from 'node:crypto'

// The X-Hinomi-Signature scheme: `t=<unix seconds>,v1=<hex>` where v1 is HMAC SHA-256 of
// `<t>.<raw body>`. The timestamp is signed too, so an old delivery cannot be replayed with a
// fresh one. The webhook runner and the generic webhook notification channel both use it.

export function timestampedDigest(
  secret: string,
  timestamp: number,
  body: Uint8Array | string,
): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest()
}

/** The X-Hinomi-Signature value for `body` sent at `at`. */
export function signTimestamped(secret: string, body: Uint8Array | string, at: Date): string {
  const timestamp = Math.floor(at.getTime() / 1000)
  return `t=${timestamp},v1=${timestampedDigest(secret, timestamp, body).toString('hex')}`
}
