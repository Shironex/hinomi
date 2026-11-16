import { describe, expect, it } from 'vitest'
import { CborError, decodeCbor, decodeCborExact } from './cbor.js'
import { cborEncode } from './testing.js'

describe('decodeCbor', () => {
  it('reads the types WebAuthn uses', () => {
    const value = new Map<string | number, unknown>([
      [1, 2],
      [-1, -7],
      ['bytes', new Uint8Array([1, 2, 3])],
      ['text', 'hinomi'],
      ['list', [true, false, null]],
      [3, 70000],
    ])
    expect(decodeCborExact(cborEncode(value as never))).toEqual(value)
  })

  it('reports where the item ends, so authenticator data can carry more after it', () => {
    const bytes = new Uint8Array([...cborEncode('ab'), 0xff])
    expect(decodeCbor(bytes)).toEqual({ value: 'ab', end: 3 })
    expect(() => decodeCborExact(bytes)).toThrow(CborError)
  })

  it.each([
    ['truncated bytes', [0x43, 1, 2]],
    ['indefinite length', [0x5f]],
    ['a tag', [0xc0, 0x01]],
    ['a float', [0xfb, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['duplicate map keys', [0xa2, 0x01, 0x01, 0x01, 0x02]],
    ['a map key that is a list', [0xa1, 0x80, 0x01]],
  ])('refuses %s', (_name, bytes) => {
    expect(() => decodeCborExact(new Uint8Array(bytes))).toThrow(CborError)
  })

  it('refuses deep nesting', () => {
    const deep = new Uint8Array([...new Array<number>(20).fill(0x81), 0x01])
    expect(() => decodeCborExact(deep)).toThrow('nested too deeply')
  })
})
