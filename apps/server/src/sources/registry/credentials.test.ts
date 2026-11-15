import { parseImageRef } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createSecretBox, SecretDecryptError } from '../../crypto/secret-box.js'
import {
  createRegistryClient,
  credentialHostAllowed,
  RegistryError,
  type RegistryLogin,
} from './client.js'
import { readImageSbom } from './read.js'
import { registryTarget } from './reference.js'
import { basicOf, CDN_HOST, FAKE_TOKEN, fakeImage, fakeRegistry, urlOf } from './testing.js'

// Registry credentials: the OCI token flow with a stored login, where the login may go, and that
// it never shows up in an error. Fictional hosts, images and secrets only.

const target = (raw: string) => registryTarget(parseImageRef(raw)!)!
const LOGIN: RegistryLogin = { username: 'kestrel-bot', secret: 'pat-fictional-secret-0001' }
const BASIC = basicOf(LOGIN)
const BASIC_B64 = BASIC.slice('Basic '.length)

async function failsWith(promise: Promise<unknown>, code: string): Promise<RegistryError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RegistryError)
  expect(error).toMatchObject({ code })
  const message = (error as Error).message
  expect(message).not.toContain(LOGIN.secret)
  expect(message).not.toContain(BASIC_B64)
  return error as RegistryError
}

/** A store with one login, recording every host it was asked for. */
function store(entries: Record<string, RegistryLogin>) {
  const asked: string[] = []
  return {
    asked,
    credentials: (host: string) => {
      asked.push(host)
      return Object.hasOwn(entries, host) ? entries[host]! : null
    },
  }
}

describe('credentialHostAllowed', () => {
  it('allows the registry host and its known auth host only, no wildcards', () => {
    expect(credentialHostAllowed('ghcr.io', 'ghcr.io')).toBe(true)
    expect(credentialHostAllowed('registry-1.docker.io', 'auth.docker.io')).toBe(true)
    expect(credentialHostAllowed('registry.gitlab.com', 'gitlab.com')).toBe(true)
    // Siblings the anonymous rule allows do not get a login.
    expect(credentialHostAllowed('registry.example.com', 'example.com')).toBe(false)
    expect(credentialHostAllowed('registry.example.com', 'auth.example.com')).toBe(false)
    expect(credentialHostAllowed('registry-1.docker.io', 'evil.docker.io')).toBe(false)
    expect(credentialHostAllowed('ghcr.io', 'auth.docker.io')).toBe(false)
    expect(credentialHostAllowed('registry.example.com:5000', 'registry.example.com')).toBe(false)
    expect(credentialHostAllowed('constructor', 'auth.docker.io')).toBe(false)
  })
})

describe('registryTarget and stored hosts', () => {
  it('drops the https default port so the host matches a stored credential', () => {
    expect(target('registry.example.com:443/kestrel/edge:1').host).toBe('registry.example.com')
    expect(target('registry.example.com:5000/kestrel/edge:1').host).toBe(
      'registry.example.com:5000',
    )
  })
})

describe('registry client with stored credentials', () => {
  it('gets a pull token with the login on ghcr.io and reads a private SBOM', async () => {
    const image = fakeImage('kestrel-co/private-api', '1.0.0')
    const registry = fakeRegistry('ghcr.io', [image], { login: LOGIN })
    const { credentials, asked } = store({ 'ghcr.io': LOGIN })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      credentials,
    })
    const t = target('ghcr.io/kestrel-co/private-api:1.0.0')
    expect(await client.resolveDigest(t)).toBe(image.indexDigest)
    const read = await readImageSbom(client, t, image.indexDigest)
    expect(read.status).toBe('sbom')

    // The login went to the token service only; the registry got the token; the CDN nothing.
    expect(registry.authorizations.filter((a) => a.includes('Basic'))).toEqual([`ghcr.io ${BASIC}`])
    expect(
      registry.authorizations
        .filter((a) => !a.includes('Basic'))
        .every((a) => a === `ghcr.io Bearer ${FAKE_TOKEN}`),
    ).toBe(true)
    expect(registry.cdnAuthorization).toEqual([])
    expect(registry.requests.some((r) => r.includes(CDN_HOST))).toBe(true)
    // Looked up once per host, by the exact host.
    expect(asked).toEqual(['ghcr.io'])
  })

  it("sends a Docker Hub login to auth.docker.io, the registry's known auth host", async () => {
    const image = fakeImage('kestrel/private-edge', '2.0')
    const registry = fakeRegistry('registry-1.docker.io', [image], {
      login: LOGIN,
      realmHost: 'auth.docker.io',
      redirectBlobs: false,
    })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      ...store({ 'registry-1.docker.io': LOGIN }),
    })
    const t = target('docker.io/kestrel/private-edge:2.0')
    expect(await client.resolveDigest(t)).toBe(image.indexDigest)
    expect(registry.authorizations).toContain(`auth.docker.io ${BASIC}`)
    expect(registry.authorizations.filter((a) => a.startsWith('registry-1.docker.io '))).toEqual([
      `registry-1.docker.io Bearer ${FAKE_TOKEN}`,
    ])
  })

  it('answers a Basic challenge with the login on the registry host only', async () => {
    const image = fakeImage('kestrel/edge', '1.0')
    const registry = fakeRegistry('registry.example.com:5000', [image], {
      login: LOGIN,
      basic: true,
    })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      ...store({ 'registry.example.com:5000': LOGIN }),
    })
    const t = target('registry.example.com:5000/kestrel/edge:1.0')
    const read = await readImageSbom(client, t, await client.resolveDigest(t))
    expect(read.status).toBe('sbom')
    expect(registry.authorizations.every((a) => a === `registry.example.com:5000 ${BASIC}`)).toBe(
      true,
    )
    // Blobs were redirected to the CDN, which never saw the login.
    expect(registry.cdnAuthorization).toEqual([])
  })

  it('never sends a login stored for another host', async () => {
    const image = fakeImage('kestrel-co/private-api', '1.0.0')
    const registry = fakeRegistry('ghcr.io', [image], { login: LOGIN })
    const { credentials, asked } = store({
      'registry.example.com': LOGIN,
      'ghcr.io.example.com': LOGIN,
    })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      credentials,
    })
    await failsWith(
      client.resolveDigest(target('ghcr.io/kestrel-co/private-api:1.0.0')),
      'unauthorized',
    )
    expect(asked).toEqual(['ghcr.io'])
    expect(registry.authorizations).toEqual([])
  })

  it('keeps the login from a token service on a sibling host that is not a known auth host', async () => {
    const image = fakeImage('kestrel/edge', '1.0')
    const registry = fakeRegistry('registry.example.com', [image], {
      login: LOGIN,
      realmHost: 'auth.example.com',
    })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      ...store({ 'registry.example.com': LOGIN }),
    })
    const error = await failsWith(
      client.resolveDigest(target('registry.example.com/kestrel/edge:1.0')),
      'unauthorized',
    )
    expect(error.message).toContain('not a known auth host')
    expect(registry.authorizations).toEqual([])
  })

  it('never follows a redirect from the token service, and refuses a private realm', async () => {
    const seen: string[] = []
    const client = createRegistryClient({
      fetch: (input, init) => {
        const url = urlOf(input)
        seen.push(`${url} ${new Headers(init?.headers).get('authorization') ?? '-'}`)
        if (url.includes('/v2/')) {
          return Promise.resolve(
            new Response(null, {
              status: 401,
              headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token"' },
            }),
          )
        }
        // A token service that answers with a redirect: the fetch is told `redirect: 'error'`.
        expect(init?.redirect).toBe('error')
        return Promise.reject(new TypeError('redirect mode is set to error'))
      },
      lookup: () => Promise.resolve(['20.0.0.1']),
      ...store({ 'registry-1.docker.io': LOGIN }),
    })
    await failsWith(client.resolveDigest(target('kestrel/edge:1')), 'failed')
    expect(seen.filter((s) => s.includes(BASIC_B64))).toHaveLength(1)

    const privateRealm = createRegistryClient({
      fetch: (input) => {
        if (urlOf(input).includes('/v2/')) {
          return Promise.resolve(
            new Response(null, {
              status: 401,
              headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token"' },
            }),
          )
        }
        throw new Error(`must not be called: ${urlOf(input)}`)
      },
      lookup: () => Promise.resolve(['10.1.2.3']),
      ...store({ 'registry-1.docker.io': LOGIN }),
    })
    await failsWith(privateRealm.resolveDigest(target('kestrel/edge:1')), 'refused')
  })

  it('says the stored login was refused, without the secret', async () => {
    const image = fakeImage('kestrel-co/private-api', '1.0.0')
    const registry = fakeRegistry('ghcr.io', [image], { login: LOGIN })
    const wrong = { username: LOGIN.username, secret: 'pat-fictional-wrong-0002' }
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      ...store({ 'ghcr.io': wrong }),
    })
    const error = await failsWith(
      client.resolveDigest(target('ghcr.io/kestrel-co/private-api:1.0.0')),
      'unauthorized',
    )
    expect(error.message).toContain('refused the stored credentials')
    expect(error.message).not.toContain(wrong.secret)
    expect(JSON.stringify(error)).not.toContain(wrong.secret)
  })

  it('turns a store that cannot decrypt into unauthorized without its details', async () => {
    const box = createSecretBox('fictional-key-one')
    const stored = box.encrypt(LOGIN.secret)
    const other = createSecretBox('fictional-key-two')
    const registry = fakeRegistry('ghcr.io', [], { login: LOGIN })
    const client = createRegistryClient({
      fetch: registry.fetch,
      lookup: registry.lookup,
      credentials: () => ({ username: LOGIN.username, secret: other.decrypt(stored) }),
    })
    expect(() => other.decrypt(stored)).toThrow(SecretDecryptError)
    const error = await failsWith(
      client.resolveDigest(target('ghcr.io/kestrel-co/private-api:1.0.0')),
      'unauthorized',
    )
    expect(error.message).toContain('HINOMI_SECRET_KEY')
    expect(error.message).not.toContain(stored)
  })

  it('does not ask the store for a registry that never wants credentials', async () => {
    const asked: string[] = []
    const client = createRegistryClient({
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
      credentials: (host) => {
        asked.push(host)
        return LOGIN
      },
    })
    await client.resolveDigest(target('ghcr.io/kestrel-co/edge-api:2.3.0'))
    expect(asked).toEqual([])
  })
})
