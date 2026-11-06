import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Encrypts small secrets (source API tokens) at rest with AES-256-GCM.
 *
 * Stored format: `v1.<base64url(iv | authTag | ciphertext)>`, with a fresh
 * random 12 byte IV per value. The key is derived from HINOMI_SECRET_KEY with
 * scrypt, so a passphrase works as well as a random string.
 */
export interface SecretBox {
  encrypt(plaintext: string): string
  decrypt(stored: string): string
}

/** Thrown when a token has to be stored or read but HINOMI_SECRET_KEY is not set. */
export class SecretKeyMissingError extends Error {
  override readonly name = 'SecretKeyMissingError'
  constructor() {
    super(
      'HINOMI_SECRET_KEY is not set, so tokens cannot be stored or read. Set it (for example to the output of `openssl rand -base64 32`) and restart Hinomi.',
    )
  }
}

/**
 * Thrown when a stored value cannot be decrypted: it was tampered with, or it
 * was written with a different HINOMI_SECRET_KEY.
 */
export class SecretDecryptError extends Error {
  override readonly name = 'SecretDecryptError'
  constructor() {
    super(
      'A stored token could not be decrypted. HINOMI_SECRET_KEY may have changed since it was saved; enter the token again.',
    )
  }
}

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
// Fixed salt: the key must be the same on every boot for the same secret.
// The secret itself is the only input that has to stay private.
const KDF_SALT = 'hinomi/secret-box/v1'
// N = 2^15 costs about 50 ms once at boot and 32 MiB of memory.
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
// Additional authenticated data ties ciphertexts to this use.
const AAD = Buffer.from('hinomi:token', 'utf8')

export function deriveKey(secret: string): Buffer {
  return scryptSync(secret, KDF_SALT, KEY_BYTES, SCRYPT_OPTIONS)
}

export function createSecretBox(secret: string): SecretBox {
  const key = deriveKey(secret)

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(AAD)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`
    },

    decrypt(stored) {
      const [version, payload, ...rest] = stored.split('.')
      if (version !== VERSION || payload === undefined || rest.length > 0) {
        throw new SecretDecryptError()
      }
      const raw = Buffer.from(payload, 'base64url')
      if (raw.length < IV_BYTES + TAG_BYTES) throw new SecretDecryptError()
      const iv = raw.subarray(0, IV_BYTES)
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
      const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(AAD)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretDecryptError()
      }
    },
  }
}
