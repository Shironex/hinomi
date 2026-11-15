import { describe, expect, it } from 'vitest'
import {
  createRegistryCredentialRequestSchema,
  normalizeRegistryHost,
  updateRegistryCredentialRequestSchema,
} from './registry-credentials.js'

describe('normalizeRegistryHost', () => {
  it('lower cases, drops a pasted scheme, a trailing slash and :443', () => {
    expect(normalizeRegistryHost('GHCR.io')).toBe('ghcr.io')
    expect(normalizeRegistryHost('https://ghcr.io/')).toBe('ghcr.io')
    expect(normalizeRegistryHost('registry.example.com:443')).toBe('registry.example.com')
    expect(normalizeRegistryHost('registry.example.com:5000')).toBe('registry.example.com:5000')
  })

  it("folds Docker Hub's names into its API host", () => {
    expect(normalizeRegistryHost('docker.io')).toBe('registry-1.docker.io')
    expect(normalizeRegistryHost('index.docker.io')).toBe('registry-1.docker.io')
    expect(normalizeRegistryHost('registry-1.docker.io')).toBe('registry-1.docker.io')
  })

  it('refuses anything that is not a plain host', () => {
    for (const bad of [
      '',
      'http://ghcr.io',
      'ghcr.io/kestrel-co',
      'user@ghcr.io',
      '*.example.com',
      'ghcr.io:0',
      'ghcr io',
    ]) {
      expect(normalizeRegistryHost(bad)).toBeNull()
    }
  })
})

describe('registry credential requests', () => {
  it('normalizes the host and requires every field on create', () => {
    expect(
      createRegistryCredentialRequestSchema.parse({
        host: 'docker.io',
        username: 'kestrel',
        secret: 'fictional-secret',
      }),
    ).toEqual({ host: 'registry-1.docker.io', username: 'kestrel', secret: 'fictional-secret' })
    expect(
      createRegistryCredentialRequestSchema.safeParse({ host: 'ghcr.io', username: 'kestrel' })
        .success,
    ).toBe(false)
  })

  it('never lets an update move a secret to another host', () => {
    expect(updateRegistryCredentialRequestSchema.safeParse({ host: 'example.com' }).success).toBe(
      false,
    )
    expect(updateRegistryCredentialRequestSchema.safeParse({}).success).toBe(false)
    expect(updateRegistryCredentialRequestSchema.parse({ secret: 'next' })).toEqual({
      secret: 'next',
    })
  })
})
