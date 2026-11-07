import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { describeError } from './errors'

const http = (message: string) => new ApiError('http', '/x', message, { status: 409 })

describe('describeError', () => {
  it('ends a server message with one full stop', () => {
    expect(describeError(http('Set the webhook runner URL first'))).toBe(
      'Set the webhook runner URL first.',
    )
    expect(describeError(http('Set the webhook runner URL first.'))).toBe(
      'Set the webhook runner URL first.',
    )
    expect(describeError(http('Is a run already going?'))).toBe('Is a run already going?')
  })
})
