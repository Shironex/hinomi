import { describe, expect, it } from 'vitest'
import { signRunnerPayload, verifyRunnerSignature } from './signature.js'

// The webhook runner's signature: HMAC SHA-256 over the timestamp and the raw body.

const SECRET = 'fictional-runner-secret-0000000000000000'
const AT = new Date('2026-11-07T10:00:00.000Z')
const body = Buffer.from('{"runId":"corr-1"}')

describe('runner signatures', () => {
  it('verifies what it signed', () => {
    const header = signRunnerPayload(SECRET, body, AT)
    expect(header).toMatch(/^t=1794045600,v1=[0-9a-f]{64}$/)
    expect(verifyRunnerSignature(SECRET, body, header, AT, 300)).toEqual({ ok: true })
  })

  it('refuses another secret, another body, a changed timestamp or no header', () => {
    const header = signRunnerPayload(SECRET, body, AT)
    expect(verifyRunnerSignature('other', body, header, AT, 300)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(verifyRunnerSignature(SECRET, Buffer.from('{}'), header, AT, 300)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    const moved = header.replace('t=1794045600', 't=1794045601')
    expect(verifyRunnerSignature(SECRET, body, moved, AT, 300)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(verifyRunnerSignature(SECRET, body, undefined, AT, 300)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(verifyRunnerSignature(SECRET, body, 'sha256=abc', AT, 300)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('refuses a valid signature outside the time window', () => {
    const old = signRunnerPayload(SECRET, body, new Date(AT.getTime() - 301_000))
    expect(verifyRunnerSignature(SECRET, body, old, AT, 300)).toEqual({
      ok: false,
      reason: 'expired',
    })
    const soon = signRunnerPayload(SECRET, body, new Date(AT.getTime() + 299_000))
    expect(verifyRunnerSignature(SECRET, body, soon, AT, 300)).toEqual({ ok: true })
  })
})
