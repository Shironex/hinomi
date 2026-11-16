/**
 * The small part of CBOR (RFC 8949) that WebAuthn needs: the attestation object and COSE keys.
 * Definite lengths only, integers up to 2^53, no tags or floats. Anything else is an error, so a
 * crafted credential is refused rather than half read.
 */

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>

export class CborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CborError'
  }
}

const MAX_DEPTH = 8
const MAX_ITEMS = 256

/** Decodes one item starting at `offset`; `end` is where the next byte after it is. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  let pos = offset

  function need(n: number): void {
    if (pos + n > bytes.length) throw new CborError('truncated CBOR')
  }

  function readLength(info: number): number {
    if (info < 24) return info
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (info === 24) {
      need(1)
      return bytes[pos++] as number
    }
    if (info === 25) {
      need(2)
      const v = view.getUint16(pos)
      pos += 2
      return v
    }
    if (info === 26) {
      need(4)
      const v = view.getUint32(pos)
      pos += 4
      return v
    }
    if (info === 27) {
      need(8)
      const v = view.getBigUint64(pos)
      pos += 8
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR integer too large')
      return Number(v)
    }
    throw new CborError('indefinite or reserved CBOR length')
  }

  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError('CBOR nested too deeply')
    need(1)
    const initial = bytes[pos++] as number
    const major = initial >> 5
    const info = initial & 0x1f
    switch (major) {
      case 0:
        return readLength(info)
      case 1:
        return -1 - readLength(info)
      case 2: {
        const n = readLength(info)
        need(n)
        const out = bytes.slice(pos, pos + n)
        pos += n
        return out
      }
      case 3: {
        const n = readLength(info)
        need(n)
        const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, pos + n))
        pos += n
        return out
      }
      case 4: {
        const n = readLength(info)
        if (n > MAX_ITEMS) throw new CborError('CBOR array too long')
        const out: CborValue[] = []
        for (let i = 0; i < n; i++) out.push(item(depth + 1))
        return out
      }
      case 5: {
        const n = readLength(info)
        if (n > MAX_ITEMS) throw new CborError('CBOR map too long')
        const out = new Map<CborValue, CborValue>()
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1)
          if (typeof key !== 'string' && typeof key !== 'number') {
            throw new CborError('CBOR map key must be a string or an integer')
          }
          if (out.has(key)) throw new CborError('duplicate CBOR map key')
          out.set(key, item(depth + 1))
        }
        return out
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        throw new CborError('unsupported CBOR simple value')
      default:
        throw new CborError('unsupported CBOR type')
    }
  }

  const value = item(0)
  return { value, end: pos }
}

/** Decodes a buffer that must hold exactly one item. */
export function decodeCborExact(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCbor(bytes)
  if (end !== bytes.length) throw new CborError('trailing bytes after CBOR')
  return value
}
