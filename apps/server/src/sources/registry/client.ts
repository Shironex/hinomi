import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { isPublicAddress } from '../../net/public-address.js'
import type { RegistryTarget } from './reference.js'

// A small read only client for the OCI distribution API (manifests and blobs) with native fetch.
// Everything a registry answers is untrusted input:
// - Requests go only to the registry host the image reference names. Its token service must be
//   on that host or a sibling of it (Docker Hub: registry-1.docker.io and auth.docker.io), over
//   https, on a public address unless it is the registry host itself.
// - Redirects are followed by hand, a few at most, https only. A redirect to another host (blob
//   storage on a CDN) must resolve to public addresses only, and never gets the token.
// - Bodies are read up to a byte cap, manifests and blobs are checked against their digest, and
//   every request has a timeout.
// Only anonymous pulls: a registry that wants credentials counts as `unauthorized`.

export const MANIFEST_MEDIA_TYPES = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
} as const
const MANIFEST_ACCEPT = Object.values(MANIFEST_MEDIA_TYPES).join(', ')

const DEFAULT_TIMEOUT_MS = 20_000
/** The OCI spec lets registries refuse manifests above 4 MiB; Hinomi reads no more either. */
const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_BLOB_BYTES = 32 * 1024 * 1024
const MAX_TOKEN_BYTES = 64 * 1024
const MAX_CHALLENGE_LENGTH = 2000
const DEFAULT_MAX_REDIRECTS = 3

const DIGEST = /^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/

export type RegistryErrorCode =
  'not_found' | 'unauthorized' | 'too_large' | 'refused' | 'invalid' | 'failed'

/** A registry read that did not work. The message never holds a token. */
export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RegistryError'
  }
}

export interface RegistryClientOptions {
  fetch?: typeof fetch
  /** Resolves a host name to its addresses, for the public address check. */
  lookup?: (hostname: string) => Promise<string[]>
  timeoutMs?: number
  maxManifestBytes?: number
  maxBlobBytes?: number
  maxRedirects?: number
}

export interface FetchedManifest {
  /** Media type from the response, else from the body; null when neither says. */
  mediaType: string | null
  body: unknown
}

export interface RegistryClient {
  /** The digest a tag points at: a HEAD (free on Docker Hub's pull limit), a GET when it does not say. */
  resolveDigest(target: RegistryTarget): Promise<string>
  /** A manifest by digest, checked against it. */
  getManifest(target: RegistryTarget, digest: string): Promise<FetchedManifest>
  /** A blob by digest, checked against it, at most the blob byte cap. */
  getBlob(target: RegistryTarget, digest: string): Promise<Buffer>
}

const tokenSchema = z.object({
  token: z.string().max(16_384).optional(),
  access_token: z.string().max(16_384).optional(),
})

async function defaultLookup(hostname: string): Promise<string[]> {
  const entries = await dnsLookup(hostname, { all: true })
  return entries.map((e) => e.address)
}

const hostnameOf = (host: string) => host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

/**
 * Whether a token service may live on `authHost` for a registry on `registryHost`: the same host,
 * or a sibling under the registry's parent domain when that parent has at least two labels
 * (registry-1.docker.io and auth.docker.io; registry.gitlab.com and gitlab.com).
 */
export function authHostAllowed(registryHost: string, authHost: string): boolean {
  const registry = hostnameOf(registryHost).toLowerCase()
  const auth = hostnameOf(authHost).toLowerCase()
  if (registry === auth) return true
  if (isIP(registry) !== 0) return false
  const labels = registry.split('.')
  if (labels.length < 3) return false
  const parent = labels.slice(1).join('.')
  return auth === parent || auth.endsWith(`.${parent}`)
}

/** Reads `key="value"` pairs of a `WWW-Authenticate` header into a Map. */
function parseChallenge(
  header: string | null,
): { scheme: 'bearer'; realm: string; service: string | null } | { scheme: 'other' } | null {
  if (!header || header.length > MAX_CHALLENGE_LENGTH) return null
  const space = header.indexOf(' ')
  const scheme = (space === -1 ? header : header.slice(0, space)).toLowerCase()
  if (scheme !== 'bearer') return { scheme: 'other' }
  const params = new Map<string, string>()
  for (const match of header.slice(space + 1).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    params.set(match[1]!.toLowerCase(), match[2]!)
  }
  const realm = params.get('realm')
  return realm ? { scheme: 'bearer', realm, service: params.get('service') ?? null } : null
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    // Nothing to do: the body is not needed.
  }
}

/** Reads a body up to `max` bytes; more is `too_large`. */
async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) {
    await drain(res)
    throw new RegistryError('too_large', `${what} is larger than ${max} bytes`)
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new RegistryError('too_large', `${what} is larger than ${max} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Throws `invalid` unless the bytes hash to the digest. */
export function verifyDigest(bytes: Buffer, digest: string, what: string): void {
  if (!DIGEST.test(digest)) throw new RegistryError('invalid', `${what} has an unusable digest`)
  const [algorithm, hex] = digest.split(':') as [string, string]
  if (createHash(algorithm).update(bytes).digest('hex') !== hex) {
    throw new RegistryError('invalid', `${what} does not match its digest`)
  }
}

export const isDigest = (value: string): boolean => DIGEST.test(value)

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const doFetch = options.fetch ?? fetch
  const lookup = options.lookup ?? defaultLookup
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  // Pull tokens per registry and repository, for the life of the client (one scan).
  const tokens = new Map<string, string>()

  /** Refuses a host that is not public (another host than the registry only). */
  async function checkPublic(url: URL): Promise<void> {
    const hostname = hostnameOf(url.host)
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new RegistryError('refused', `the registry pointed to ${hostname}, a local address`)
    }
    let addresses: string[]
    if (isIP(hostname) !== 0) addresses = [hostname]
    else {
      try {
        addresses = await lookup(hostname)
      } catch (error) {
        throw new RegistryError(
          'failed',
          `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    const bad = addresses.find((a) => !isPublicAddress(a))
    if (bad !== undefined || addresses.length === 0) {
      throw new RegistryError(
        'refused',
        `the registry pointed to ${hostname}, which is not a public address`,
      )
    }
  }

  async function call(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new RegistryError(
        'failed',
        `${url.host} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  async function fetchToken(
    target: RegistryTarget,
    challenge: { realm: string; service: string | null },
  ): Promise<string> {
    let realm: URL
    try {
      realm = new URL(challenge.realm)
    } catch {
      throw new RegistryError('invalid', `${target.host} named a token service that is not a URL`)
    }
    if (realm.protocol !== 'https:' || realm.username !== '' || realm.password !== '') {
      throw new RegistryError('refused', `${target.host} named a token service that is not https`)
    }
    if (!authHostAllowed(target.host, realm.host)) {
      throw new RegistryError(
        'refused',
        `${target.host} named a token service on another host (${realm.hostname})`,
      )
    }
    if (realm.host !== target.host) await checkPublic(realm)
    if (challenge.service) realm.searchParams.set('service', challenge.service)
    realm.searchParams.set('scope', `repository:${target.repository}:pull`)
    const res = await call(realm, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
    })
    if (res.status === 401 || res.status === 403) {
      await drain(res)
      // ghcr.io answers the same for a private image and one that does not exist.
      throw new RegistryError(
        'unauthorized',
        `${target.host} wants credentials for this image (private, or it does not exist)`,
      )
    }
    if (!res.ok) {
      await drain(res)
      throw new RegistryError(
        'failed',
        `the token service of ${target.host} answered ${res.status}`,
      )
    }
    let body: unknown
    try {
      body = JSON.parse((await readCapped(res, MAX_TOKEN_BYTES, 'the token answer')).toString())
    } catch (error) {
      if (error instanceof RegistryError) throw error
      throw new RegistryError('invalid', `the token service of ${target.host} answered no JSON`, {
        cause: error,
      })
    }
    const parsed = tokenSchema.safeParse(body)
    const token = parsed.success ? (parsed.data.token ?? parsed.data.access_token) : undefined
    if (!token) {
      throw new RegistryError('invalid', `the token service of ${target.host} gave no token`)
    }
    return token
  }

  /**
   * One request against the registry: the pull token on a 401, redirects by hand. Returns the
   * final response; the caller reads or drains it.
   */
  async function send(
    target: RegistryTarget,
    path: string,
    method: 'GET' | 'HEAD',
    accept: string,
  ): Promise<Response> {
    const tokenKey = `${target.host}/${target.repository}`
    let url = new URL(`https://${target.host}/v2/${target.repository}/${path}`)
    let askedToken = false
    for (let hops = 0; ;) {
      const sameHost = url.host === target.host
      const headers: Record<string, string> = { accept }
      const token = sameHost ? tokens.get(tokenKey) : undefined
      if (token) headers.authorization = `Bearer ${token}`
      if (!sameHost) await checkPublic(url)
      const res = await call(url, { method, headers, redirect: 'manual' })
      if (res.status === 401 && sameHost && !askedToken) {
        askedToken = true
        await drain(res)
        const challenge = parseChallenge(res.headers.get('www-authenticate'))
        if (challenge?.scheme !== 'bearer') {
          throw new RegistryError('unauthorized', `${target.host} wants credentials for this image`)
        }
        tokens.set(tokenKey, await fetchToken(target, challenge))
        continue
      }
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await drain(res)
        if (++hops > maxRedirects) {
          throw new RegistryError('refused', `${target.host} redirected too many times`)
        }
        try {
          url = new URL(location, url)
        } catch {
          throw new RegistryError('invalid', `${target.host} redirected to something not a URL`)
        }
        if (url.protocol !== 'https:') {
          throw new RegistryError('refused', `${target.host} redirected to a URL that is not https`)
        }
        continue
      }
      return res
    }
  }

  async function failure(res: Response, what: string): Promise<RegistryError> {
    await drain(res)
    if (res.status === 404) return new RegistryError('not_found', `${what} was not found`)
    if (res.status === 401 || res.status === 403) {
      return new RegistryError('unauthorized', `${what} needs credentials (${res.status})`)
    }
    if (res.status === 429) return new RegistryError('failed', `${what}: rate limited (429)`)
    return new RegistryError('failed', `${what}: the registry answered ${res.status}`)
  }

  function parseManifest(res: Response, bytes: Buffer, what: string): FetchedManifest {
    let body: unknown
    try {
      body = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new RegistryError('invalid', `${what} is not JSON`)
    }
    const header = res.headers.get('content-type')?.split(';')[0]?.trim() || null
    const own =
      body !== null && typeof body === 'object' && Object.hasOwn(body, 'mediaType')
        ? (body as { mediaType: unknown }).mediaType
        : null
    return { mediaType: header ?? (typeof own === 'string' ? own : null), body }
  }

  return {
    async resolveDigest(target) {
      if (target.digest) return target.digest
      const reference = target.tag ?? 'latest'
      const what = `${target.host}/${target.repository}:${reference}`
      const path = `manifests/${encodeURIComponent(reference)}`
      const head = await send(target, path, 'HEAD', MANIFEST_ACCEPT)
      await drain(head)
      const said = head.headers.get('docker-content-digest')?.trim().toLowerCase()
      if (head.ok && said && isDigest(said)) return said
      if (!head.ok && head.status !== 405) throw await failure(head, what)
      // The registry did not name the digest: read the manifest and hash it.
      const res = await send(target, path, 'GET', MANIFEST_ACCEPT)
      if (!res.ok) throw await failure(res, what)
      const bytes = await readCapped(res, maxManifestBytes, `the manifest of ${what}`)
      return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    },

    async getManifest(target, digest) {
      const what = `the manifest ${digest} of ${target.host}/${target.repository}`
      if (!isDigest(digest)) throw new RegistryError('invalid', `${what} has an unusable digest`)
      const res = await send(target, `manifests/${digest}`, 'GET', MANIFEST_ACCEPT)
      if (!res.ok) throw await failure(res, what)
      const bytes = await readCapped(res, maxManifestBytes, what)
      verifyDigest(bytes, digest, what)
      return parseManifest(res, bytes, what)
    },

    async getBlob(target, digest) {
      const what = `the blob ${digest} of ${target.host}/${target.repository}`
      if (!isDigest(digest)) throw new RegistryError('invalid', `${what} has an unusable digest`)
      const res = await send(target, `blobs/${digest}`, 'GET', '*/*')
      if (!res.ok) throw await failure(res, what)
      const bytes = await readCapped(res, maxBlobBytes, what)
      verifyDigest(bytes, digest, what)
      return bytes
    },
  }
}
