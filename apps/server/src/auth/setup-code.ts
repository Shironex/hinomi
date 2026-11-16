import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'

/**
 * One time setup codes: how the first passkey is registered, and how a lost one is replaced.
 * Only `hinomi-auth setup-code` (or `reset`) in the container makes one and prints it to that
 * terminal, never to the server log. The settings row holds its SHA-256 and expiry; using it
 * removes the row.
 */

export const SETUP_CODE_KEY = 'auth.setupCode'
export const SETUP_CODE_TTL_MS = 15 * 60 * 1000
/** No 0/O, 1/I/L: read off a terminal and typed by hand. 12 of them are 60 bits. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const LENGTH = 12

const storedSchema = z.object({ hash: z.string().length(64), expiresAt: z.number().int() })

const digest = (normalized: string) => createHash('sha256').update(normalized).digest('hex')

/** Upper case, without the dashes and spaces people type between groups. */
export const normalizeSetupCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '')

/** Makes a new code, replacing any earlier one, and returns it as `XXXX-XXXX-XXXX`. */
export function issueSetupCode(
  settings: SettingsRepository,
  now: Date,
): { code: string; expiresAt: Date } {
  let raw = ''
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)]
  const expiresAt = new Date(now.getTime() + SETUP_CODE_TTL_MS)
  settings.set(SETUP_CODE_KEY, { hash: digest(raw), expiresAt: expiresAt.getTime() })
  return { code: raw.match(/.{4}/g)?.join('-') ?? raw, expiresAt }
}

/**
 * Spends the code when it matches and has not expired. The comparison is between two SHA-256
 * digests in constant time.
 */
export function consumeSetupCode(settings: SettingsRepository, code: string, now: Date): boolean {
  const stored = settings.get(SETUP_CODE_KEY, storedSchema)
  if (!stored) return false
  if (stored.expiresAt <= now.getTime()) {
    settings.remove(SETUP_CODE_KEY)
    return false
  }
  const given = Buffer.from(digest(normalizeSetupCode(code)), 'hex')
  const expected = Buffer.from(stored.hash, 'hex')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  return settings.remove(SETUP_CODE_KEY)
}
