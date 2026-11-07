import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from './health.js'

describe('healthResponseSchema', () => {
  it('accepts an ok status with the running version', () => {
    const body = { status: 'ok', version: '0.3.0' }
    expect(healthResponseSchema.parse(body)).toEqual(body)
  })

  it('rejects any other status', () => {
    expect(healthResponseSchema.safeParse({ status: 'down', version: 'dev' }).success).toBe(false)
  })
})
