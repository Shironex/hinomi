import { describe, expect, it } from 'vitest'
import { authHostAllowed, createRegistryClient, RegistryError } from './client.js'
import { readImageSbom } from './read.js'
import { registryTarget } from './reference.js'
import { CDN_HOST, digestOf, FAKE_TOKEN, fakeImage, fakeRegistry, urlOf } from './testing.js'
import { parseImageRef } from '@hinomi/shared'

const target = (raw: string) => registryTarget(parseImageRef(raw)!)!

/** Awaits a read that must fail and returns its RegistryError, asserting the code. */
async function failsWith(promise: Promise<unknown>, code: string): Promise<RegistryError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RegistryError)
  expect(error).toMatchObject({ code })
  return error as RegistryError
}

describe('registryTarget', () => {
  it('expands Docker Hub short names and keeps other registries as named', () => {
    expect(target('node:22-alpine')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'library/node',
      tag: '22-alpine',
      digest: null,
    })
    expect(target('docker.io/kestrel/edge')).toMatchObject({
      host: 'registry-1.docker.io',
      repository: 'kestrel/edge',
      tag: 'latest',
    })
    expect(target(`ghcr.io/kestrel-co/edge-api@sha256:${'a'.repeat(64)}`)).toMatchObject({
      host: 'ghcr.io',
      tag: null,
      digest: `sha256:${'a'.repeat(64)}`,
    })
    expect(target('registry.example.dev:5000/kestrel/edge:1.0').host).toBe(
      'registry.example.dev:5000',
    )
  })
})

describe('authHostAllowed', () => {
  it('allows the registry host and siblings under a parent of two labels or more', () => {
    expect(authHostAllowed('ghcr.io', 'ghcr.io')).toBe(true)
    expect(authHostAllowed('registry-1.docker.io', 'auth.docker.io')).toBe(true)
    expect(authHostAllowed('registry.example.dev', 'example.dev')).toBe(true)
    expect(authHostAllowed('ghcr.io', 'auth.ghcr.io.example.dev')).toBe(false)
    expect(authHostAllowed('ghcr.io', 'evil.io')).toBe(false)
    expect(authHostAllowed('registry-1.docker.io', 'docker.io.example.dev')).toBe(false)
    expect(authHostAllowed('10.0.0.5:5000', '10.0.0.6')).toBe(false)
  })
})

describe('createRegistryClient', () => {
  const edge = () => fakeImage('kestrel-co/edge-api', '2.3.0')

  it('gets an anonymous pull token and resolves a tag with a HEAD', async () => {
    const image = edge()
    const registry = fakeRegistry('ghcr.io', [image])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    const digest = await client.resolveDigest(target('ghcr.io/kestrel-co/edge-api:2.3.0'))
    expect(digest).toBe(image.indexDigest)
    expect(registry.requests).toEqual([
      'HEAD https://ghcr.io/v2/kestrel-co/edge-api/manifests/2.3.0',
      'GET https://ghcr.io/token',
      'HEAD https://ghcr.io/v2/kestrel-co/edge-api/manifests/2.3.0',
    ])
  })

  it('reads the SBOM through the index, the attestation manifest and the CDN blob', async () => {
    const image = edge()
    const registry = fakeRegistry('ghcr.io', [image])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    const t = target('ghcr.io/kestrel-co/edge-api:2.3.0')
    const read = await readImageSbom(client, t, image.indexDigest)
    expect(read.status).toBe('sbom')
    if (read.status !== 'sbom') return
    expect(read.sbom).toMatchObject({
      digest: image.indexDigest,
      platform: 'linux/amd64',
      format: 'spdx',
      truncated: false,
      unreadable: 0,
      skipped: 1,
    })
    expect(read.sbom.packages.map((p) => `${p.ecosystem} ${p.name} ${p.version}`)).toEqual([
      'Alpine:v3.20 openssl 3.3.1-r0',
      'Alpine:v3.20 musl 1.2.5-r0',
      'Go golang.org/x/net 0.20.0',
      'Go github.com/kestrel-co/edge-router 1.4.0',
    ])
    // The token went to the registry only, never to the CDN host.
    expect(registry.cdnAuthorization).toEqual([])
    expect(registry.requests.filter((r) => r.includes(CDN_HOST))).toHaveLength(1)
    // One token for the whole read.
    expect(registry.requests.filter((r) => r.endsWith('/token'))).toHaveLength(1)
  })

  it('reads an SBOM in a DSSE envelope', async () => {
    const image = fakeImage('kestrel-co/edge-api', '2.3.0', { dsse: true })
    const registry = fakeRegistry('ghcr.io', [image])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    const read = await readImageSbom(
      client,
      target('ghcr.io/kestrel-co/edge-api:2.3.0'),
      image.indexDigest,
    )
    expect(read.status).toBe('sbom')
  })

  it('says why there is no SBOM: single manifest, provenance only', async () => {
    const single = fakeImage('kestrel-co/plain', '1.0.0', { singleManifest: true })
    const provenance = fakeImage('kestrel-co/prov', '1.0.0', { spdxPackages: null })
    const registry = fakeRegistry('ghcr.io', [single, provenance])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    expect(
      await readImageSbom(client, target('ghcr.io/kestrel-co/plain:1.0.0'), single.indexDigest),
    ).toMatchObject({ status: 'none', reason: 'no_index' })
    expect(
      await readImageSbom(client, target('ghcr.io/kestrel-co/prov:1.0.0'), provenance.indexDigest),
    ).toMatchObject({ status: 'none', reason: 'no_sbom' })
    const arm = await readImageSbom(
      client,
      target('ghcr.io/kestrel-co/prov:1.0.0'),
      provenance.indexDigest,
      { platforms: ['linux/arm64'] },
    )
    expect(arm).toMatchObject({ status: 'none', reason: 'no_sbom' })
    expect(arm.status === 'none' && arm.detail).toContain('linux/arm64')
  })

  it('refuses an SBOM about another image', async () => {
    const image = fakeImage('kestrel-co/edge-api', '2.3.0', { wrongSubject: true })
    const registry = fakeRegistry('ghcr.io', [image])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    await failsWith(
      readImageSbom(client, target('ghcr.io/kestrel-co/edge-api:2.3.0'), image.indexDigest),
      'invalid',
    )
  })

  it('maps 404 and a registry that wants credentials', async () => {
    const registry = fakeRegistry('ghcr.io', [])
    const client = createRegistryClient({ fetch: registry.fetch, lookup: registry.lookup })
    await failsWith(client.resolveDigest(target('ghcr.io/kestrel-co/missing:1.0')), 'not_found')

    const basic = createRegistryClient({
      fetch: () =>
        Promise.resolve(
          new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } }),
        ),
    })
    await failsWith(
      basic.resolveDigest(target('registry.example.dev/kestrel/edge:1')),
      'unauthorized',
    )
  })

  it('refuses a token service on another host and one that is not https', async () => {
    const challenge = (realm: string) =>
      createRegistryClient({
        fetch: (input) => {
          if (urlOf(input).includes('/v2/')) {
            return Promise.resolve(
              new Response(null, {
                status: 401,
                headers: { 'www-authenticate': `Bearer realm="${realm}",service="x"` },
              }),
            )
          }
          throw new Error(`must not be called: ${urlOf(input)}`)
        },
        lookup: () => Promise.resolve(['20.0.0.1']),
      })
    const t = target('ghcr.io/kestrel-co/edge-api:2.3.0')
    await failsWith(challenge('https://metadata.example.dev/token').resolveDigest(t), 'refused')
    await failsWith(challenge('http://ghcr.io/token').resolveDigest(t), 'refused')
    await failsWith(challenge('not a url').resolveDigest(t), 'invalid')
  })

  it('refuses a token service sibling that resolves to a private address', async () => {
    const calls: string[] = []
    const client = createRegistryClient({
      fetch: (input) => {
        calls.push(urlOf(input))
        return Promise.resolve(
          new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token"' },
          }),
        )
      },
      lookup: () => Promise.resolve(['169.254.169.254']),
    })
    await failsWith(client.resolveDigest(target('node:22')), 'refused')
    expect(calls.every((c) => !c.includes('auth.docker.io'))).toBe(true)
  })

  it('refuses a redirect to a private address or to plain http, and caps redirects', async () => {
    const redirectTo = (location: string, lookup: string[] = ['20.0.0.1']) =>
      createRegistryClient({
        fetch: (input) =>
          urlOf(input).startsWith('https://ghcr.io/')
            ? Promise.resolve(new Response(null, { status: 307, headers: { location } }))
            : Promise.reject(new Error(`must not be called: ${urlOf(input)}`)),
        lookup: () => Promise.resolve(lookup),
      })
    const t = target('ghcr.io/kestrel-co/edge-api:2.3.0')
    const digest = `sha256:${'a'.repeat(64)}`
    await failsWith(redirectTo('https://10.0.0.8/blob').getBlob(t, digest), 'refused')
    await failsWith(redirectTo('https://localhost/blob').getBlob(t, digest), 'refused')
    await failsWith(
      redirectTo('https://cdn.example.dev/blob', ['192.168.1.4']).getBlob(t, digest),
      'refused',
    )
    await failsWith(redirectTo('http://cdn.example.dev/blob').getBlob(t, digest), 'refused')
    await failsWith(redirectTo('/v2/kestrel-co/edge-api/blobs/again').getBlob(t, digest), 'refused')
  })

  it('caps sizes and checks digests', async () => {
    const big = Buffer.alloc(2048, 1)
    const serve = (body: Buffer, headers: Record<string, string> = {}) =>
      createRegistryClient({
        fetch: () => Promise.resolve(new Response(body, { status: 200, headers })),
        maxBlobBytes: 1024,
        maxManifestBytes: 1024,
      })
    const t = target('ghcr.io/kestrel-co/edge-api:2.3.0')
    await failsWith(serve(big).getBlob(t, digestOf(big)), 'too_large')
    await failsWith(
      serve(big, { 'content-length': String(big.length) }).getManifest(t, digestOf(big)),
      'too_large',
    )
    const small = Buffer.from('{"layers":[]}')
    await failsWith(serve(small).getBlob(t, `sha256:${'0'.repeat(64)}`), 'invalid')
    await failsWith(serve(small).getBlob(t, 'md5:abc'), 'invalid')
    expect((await serve(small).getManifest(t, digestOf(small))).body).toEqual({ layers: [] })
  })

  it('turns network failures, timeouts and 429 into failed reads without the token', async () => {
    const t = target('ghcr.io/kestrel-co/edge-api:2.3.0')
    const down = createRegistryClient({ fetch: () => Promise.reject(new Error('ECONNRESET')) })
    const error = await failsWith(down.resolveDigest(t), 'failed')
    expect(error.message).not.toContain(FAKE_TOKEN)
    const limited = createRegistryClient({
      fetch: () => Promise.resolve(new Response(null, { status: 429 })),
    })
    expect((await failsWith(limited.resolveDigest(t), 'failed')).message).toContain('429')
  })

  it('hashes the manifest when the registry does not name the digest', async () => {
    const body = Buffer.from('{"schemaVersion":2,"manifests":[]}')
    const client = createRegistryClient({
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    })
    expect(await client.resolveDigest(target('ghcr.io/kestrel-co/edge-api:2.3.0'))).toBe(
      digestOf(body),
    )
  })
})
