import { parseImageRef } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { readImagePin, readPinValue } from './value.js'

const node = (raw: string, range = false) => readPinValue('node', raw, { range })

describe('readPinValue node', () => {
  it('reads lines and versions as exact', () => {
    expect(node('22')).toEqual({ kind: 'exact', version: '22', lineName: '22' })
    expect(node('v22.11.0')).toEqual({ kind: 'exact', version: '22.11.0', lineName: '22' })
    expect(node('"20.10"')).toEqual({ kind: 'exact', version: '20.10', lineName: '20' })
  })

  it('maps lts codenames to their line and keeps lts/* floating', () => {
    expect(node('lts/jod')).toEqual({ kind: 'exact', version: '22', lineName: '22' })
    expect(node('lts/*')).toMatchObject({ kind: 'floating', version: 'lts' })
    expect(node('lts/-1')).toMatchObject({ kind: 'floating' })
    expect(node('lts/unheard-of')).toMatchObject({ kind: 'unknown' })
    for (const word of ['node', 'latest', 'current', 'stable']) {
      expect(node(word).kind).toBe('floating')
    }
  })

  it('reads ranges with their floor as the line', () => {
    expect(node('>=20 <23', true)).toMatchObject({ kind: 'range', lineName: '20' })
    expect(node('^22.1.0')).toMatchObject({ kind: 'range', lineName: '22' })
    expect(node('20.x')).toMatchObject({ kind: 'range', lineName: '20' })
    expect(node('^18 || ^20 || >=22')).toMatchObject({ kind: 'range', lineName: '18' })
    expect(node('18 - 20')).toMatchObject({ kind: 'range', lineName: '18' })
    expect(node('<23')).toMatchObject({ kind: 'range', lineName: null })
    expect(node('*', true)).toMatchObject({ kind: 'range', lineName: null })
    expect(node('*', false).kind).toBe('floating')
  })

  it('does not read nonsense', () => {
    expect(node('')).toMatchObject({ kind: 'unknown', version: null })
    expect(node('system').kind).toBe('unknown')
    expect(node('$NODE_VERSION').kind).toBe('unknown')
  })
})

describe('readPinValue bun and rust', () => {
  it('reads bun by its major', () => {
    expect(readPinValue('bun', '1.2.3')).toEqual({ kind: 'exact', version: '1.2.3', lineName: '1' })
    expect(readPinValue('bun', 'latest').kind).toBe('floating')
    expect(readPinValue('bun', 'canary').kind).toBe('floating')
  })

  it('treats rust channels as floating, never as versions', () => {
    for (const channel of [
      'stable',
      'beta',
      'nightly',
      'nightly-2025-01-05',
      'stable-x86_64-unknown-linux-gnu',
    ]) {
      const pin = readPinValue('rust', channel)
      expect(pin).toMatchObject({ kind: 'floating', lineName: null })
      expect(pin.version).toMatch(/^(stable|beta|nightly)$/)
    }
  })

  it('reads rust versions by major.minor and strips a host triple', () => {
    expect(readPinValue('rust', '1.82.0')).toEqual({
      kind: 'exact',
      version: '1.82.0',
      lineName: '1.82',
    })
    expect(readPinValue('rust', '1.82')).toMatchObject({ kind: 'exact', lineName: '1.82' })
    expect(readPinValue('rust', '1.82.0-x86_64-unknown-linux-gnu')).toMatchObject({
      version: '1.82.0',
    })
    // `1` is the newest 1.x, so it floats.
    expect(readPinValue('rust', '1')).toMatchObject({ kind: 'floating', lineName: null })
  })
})

describe('readImagePin', () => {
  const pin = (runtime: 'node' | 'bun' | 'rust', image: string) => {
    const ref = parseImageRef(image)
    if (!ref) throw new Error(image)
    return readImagePin(runtime, ref)
  }

  it('reads the leading version of a tag', () => {
    expect(pin('node', 'node:22-alpine')).toMatchObject({ kind: 'exact', lineName: '22' })
    expect(pin('node', 'node:22.11-bookworm-slim')).toMatchObject({ version: '22.11' })
    expect(pin('bun', 'oven/bun:1.1.0-alpine')).toMatchObject({ kind: 'exact', lineName: '1' })
    expect(pin('rust', 'rust:1.82-slim')).toMatchObject({ kind: 'exact', lineName: '1.82' })
  })

  it('floats on lts, latest, no tag and tags without a version', () => {
    expect(pin('node', 'node:lts')).toMatchObject({ kind: 'floating', version: 'lts' })
    expect(pin('node', 'node:lts-alpine')).toMatchObject({ kind: 'floating', version: 'lts' })
    expect(pin('node', 'node:latest')).toMatchObject({ kind: 'floating', version: 'latest' })
    expect(pin('node', 'node:alpine')).toMatchObject({ kind: 'floating', version: 'latest' })
    expect(pin('node', 'node')).toMatchObject({ kind: 'floating' })
    expect(pin('rust', 'rust:nightly')).toMatchObject({ kind: 'floating', version: 'nightly' })
    expect(pin('rust', 'rust:1')).toMatchObject({ kind: 'floating' })
  })

  it('maps codename tags and treats a digest without a tag as unknown', () => {
    expect(pin('node', 'node:lts-jod')).toMatchObject({ kind: 'exact', lineName: '22' })
    expect(pin('node', 'node:iron-alpine')).toMatchObject({ kind: 'exact', lineName: '20' })
    const digest = `node@sha256:${'a'.repeat(64)}`
    expect(pin('node', digest)).toMatchObject({ kind: 'unknown' })
    expect(pin('node', `node:22@sha256:${'a'.repeat(64)}`)).toMatchObject({ lineName: '22' })
  })
})
