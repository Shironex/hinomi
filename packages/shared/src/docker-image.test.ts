import { describe, expect, it } from 'vitest'
import { hasNonrootTag, imageRuntime, imageTagVersion, parseImageRef } from './docker-image.js'

const ref = (raw: string) => {
  const parsed = parseImageRef(raw)
  if (!parsed) throw new Error(`not parsed: ${raw}`)
  return parsed
}

describe('parseImageRef', () => {
  it('splits name and tag', () => {
    expect(ref('node:22-alpine')).toMatchObject({
      registry: null,
      repository: 'node',
      name: 'node',
      tag: '22-alpine',
      digest: null,
    })
  })

  it('treats a colon before the last slash as a registry port', () => {
    expect(ref('localhost:5000/app')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'app',
      tag: null,
    })
    expect(ref('registry.example.dev:5000/team/app:1.2')).toMatchObject({
      registry: 'registry.example.dev:5000',
      repository: 'team/app',
      tag: '1.2',
    })
  })

  it('reads a digest with and without a tag', () => {
    const digest = `sha256:${'b'.repeat(64)}`
    expect(ref(`node@${digest}`)).toMatchObject({ tag: null, digest })
    expect(ref(`node:22@${digest}`)).toMatchObject({ tag: '22', digest })
  })

  it('drops the library prefix only on Docker Hub', () => {
    expect(ref('library/node:22').repository).toBe('node')
    expect(ref('docker.io/library/node:22').repository).toBe('node')
    expect(ref('mirror.example.dev/library/node:22').repository).toBe('library/node')
  })

  it('rejects what is not a reference', () => {
    for (const bad of ['', 'node:${V}', '$IMAGE', 'Node:22', 'a b', 'node@sha256:short', 'node:']) {
      expect(parseImageRef(bad), bad).toBeNull()
    }
  })
})

describe('imageRuntime', () => {
  it('knows node, bun and rust, with mirrors', () => {
    expect(imageRuntime(ref('node:22'))).toBe('node')
    expect(imageRuntime(ref('mirror.example.dev/proxy/node:22'))).toBe('node')
    expect(imageRuntime(ref('oven/bun:1'))).toBe('bun')
    expect(imageRuntime(ref('mirror.example.dev/oven/bun:1'))).toBe('bun')
    expect(imageRuntime(ref('rust:1.82'))).toBe('rust')
    expect(imageRuntime(ref('nginx:1.27'))).toBeNull()
    expect(imageRuntime(ref('bun:1'))).toBeNull()
  })
})

describe('imageTagVersion', () => {
  it('takes the leading numeric part', () => {
    expect(imageTagVersion(ref('node:22-alpine'))).toBe('22')
    expect(imageTagVersion(ref('node:22.11-bookworm-slim'))).toBe('22.11')
    expect(imageTagVersion(ref('rust:1.82.0-slim'))).toBe('1.82.0')
    expect(imageTagVersion(ref('oven/bun:1'))).toBe('1')
    expect(imageTagVersion(ref('node:v22'))).toBe('22')
  })

  it('is null for floating tags, no tag and digest only', () => {
    for (const raw of [
      'node:lts',
      'node:latest',
      'node:alpine',
      'node:current-slim',
      'node',
      'node@sha256:' + 'c'.repeat(64),
    ]) {
      expect(imageTagVersion(ref(raw)), raw).toBeNull()
    }
  })
})

describe('hasNonrootTag', () => {
  it('matches tags ending in nonroot', () => {
    expect(hasNonrootTag(ref('gcr.io/distroless/static:nonroot'))).toBe(true)
    expect(hasNonrootTag(ref('gcr.io/distroless/base:debug-nonroot'))).toBe(true)
    expect(hasNonrootTag(ref('node:22'))).toBe(false)
    expect(hasNonrootTag(ref('node'))).toBe(false)
  })
})
