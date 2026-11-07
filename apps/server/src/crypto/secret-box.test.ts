import { describe, expect, it } from 'vitest'
import { createSecretBox, SecretDecryptError } from './secret-box.js'

const SECRET = 'a-long-enough-secret-for-tests'
const TOKEN = 'ghp_fictional0000000000000000000000000000'

describe('secret box', () => {
  const box = createSecretBox(SECRET)

  it('round trips a token', () => {
    const stored = box.encrypt(TOKEN)
    expect(stored.startsWith('v1.')).toBe(true)
    expect(stored).not.toContain(TOKEN)
    expect(box.decrypt(stored)).toBe(TOKEN)
  })

  it('round trips unicode and empty values', () => {
    expect(box.decrypt(box.encrypt('火の見 token ✓'))).toBe('火の見 token ✓')
    expect(box.decrypt(box.encrypt(''))).toBe('')
  })

  it('uses a fresh IV for every value', () => {
    const a = box.encrypt(TOKEN)
    const b = box.encrypt(TOKEN)
    expect(a).not.toBe(b)
    expect(a.slice(3, 19)).not.toBe(b.slice(3, 19))
  })

  it('a second box with the same secret decrypts (stable key)', () => {
    expect(createSecretBox(SECRET).decrypt(box.encrypt(TOKEN))).toBe(TOKEN)
  })

  it('rejects a value encrypted with another secret', () => {
    const other = createSecretBox('another-long-enough-secret')
    expect(() => other.decrypt(box.encrypt(TOKEN))).toThrow(SecretDecryptError)
  })

  it('detects a tampered ciphertext, IV or tag', () => {
    const stored = box.encrypt(TOKEN)
    const raw = Buffer.from(stored.slice(3), 'base64url')
    // IV is bytes 0..11, tag 12..27, ciphertext after.
    for (const index of [0, 12, raw.length - 1]) {
      const tampered = Buffer.from(raw)
      tampered[index] = (tampered[index] ?? 0) ^ 0x01
      expect(() => box.decrypt(`v1.${tampered.toString('base64url')}`)).toThrow(SecretDecryptError)
    }
  })

  it('rejects truncated, malformed and unknown version values', () => {
    const stored = box.encrypt(TOKEN)
    expect(() => box.decrypt(stored.slice(0, 20))).toThrow(SecretDecryptError)
    expect(() => box.decrypt('v1.')).toThrow(SecretDecryptError)
    expect(() => box.decrypt('not-a-secret')).toThrow(SecretDecryptError)
    expect(() => box.decrypt(stored.replace(/^v1\./, 'v2.'))).toThrow(SecretDecryptError)
  })

  it('never puts the plaintext in the error message', () => {
    let caught: unknown
    try {
      createSecretBox('another-long-enough-secret').decrypt(box.encrypt(TOKEN))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SecretDecryptError)
    expect(String(caught)).not.toContain(TOKEN)
  })
})
