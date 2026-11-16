import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import type { PasskeyAssertion, PasskeyCreationOptions, PasskeyRegistration } from '@hinomi/shared'
import { nowMs } from '@hinomi/shared'

// Test helpers: a CBOR encoder and a software authenticator that answers like a browser would.

type Encodable =
  number | string | Uint8Array | boolean | null | Encodable[] | Map<Encodable, Encodable>

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length]
  if (length < 0x100) return [(major << 5) | 24, length]
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff]
  return [
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]
}

export function cborEncode(value: Encodable): Uint8Array {
  const out: number[] = []
  const put = (v: Encodable): void => {
    if (typeof v === 'number') {
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)))
    } else if (typeof v === 'string') {
      const bytes = Buffer.from(v, 'utf8')
      out.push(...head(3, bytes.length), ...bytes)
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v)
    } else if (typeof v === 'boolean') {
      out.push(v ? 0xf5 : 0xf4)
    } else if (v === null) {
      out.push(0xf6)
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length))
      v.forEach(put)
    } else {
      out.push(...head(5, v.size))
      for (const [k, item] of v) {
        put(k)
        put(item)
      }
    }
  }
  put(value)
  return new Uint8Array(out)
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

export interface CeremonyOverrides {
  origin?: string
  type?: string
  /** Authenticator data flags; default UP | UV (| AT when registering). */
  flags?: number
  rpId?: string
  /** Sign with this key instead of the registered one. */
  signWith?: KeyObject
  signCount?: number
  crossOrigin?: boolean
  userHandle?: string | null
  challenge?: string
}

/** One P-256 passkey, kept in memory, answering create() and get() for an origin. */
export function createSoftAuthenticator({ origin }: { origin: string }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const credentialId = randomBytes(16)
  let counter = 0
  let userHandle: string | null = null

  function authData(rpId: string, flags: number, count: number, attested?: Uint8Array): Uint8Array {
    const countBytes = Buffer.alloc(4)
    countBytes.writeUInt32BE(count)
    return Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      countBytes,
      ...(attested ? [attested] : []),
    ])
  }

  function clientData(type: string, challenge: string, o: CeremonyOverrides): string {
    return b64url(
      Buffer.from(
        JSON.stringify({
          type,
          challenge,
          origin: o.origin ?? origin,
          ...(o.crossOrigin !== undefined && { crossOrigin: o.crossOrigin }),
        }),
      ),
    )
  }

  return {
    credentialId: b64url(credentialId),
    privateKey,

    register(options: PasskeyCreationOptions, o: CeremonyOverrides = {}): PasskeyRegistration {
      userHandle = options.user.id
      const jwk = publicKey.export({ format: 'jwk' })
      const cose = cborEncode(
        new Map<Encodable, Encodable>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x as string, 'base64url')],
          [-3, Buffer.from(jwk.y as string, 'base64url')],
        ]),
      )
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(credentialId.length)
      const attested = Buffer.concat([Buffer.alloc(16), idLength, credentialId, cose])
      const data = authData(
        o.rpId ?? options.rp.id,
        o.flags ?? 0x45,
        o.signCount ?? counter,
        attested,
      )
      const attestationObject = cborEncode(
        new Map<Encodable, Encodable>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', data],
        ]),
      )
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: clientData(
            o.type ?? 'webauthn.create',
            o.challenge ?? options.challenge,
            o,
          ),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
      }
    },

    assert(
      options: { challenge: string; rpId: string },
      o: CeremonyOverrides = {},
    ): PasskeyAssertion {
      if (o.signCount === undefined) counter += 1
      const data = authData(o.rpId ?? options.rpId, o.flags ?? 0x05, o.signCount ?? counter)
      const cd = clientData(o.type ?? 'webauthn.get', o.challenge ?? options.challenge, o)
      const signature = sign(
        'sha256',
        Buffer.concat([data, sha256(Buffer.from(cd, 'base64url'))]),
        { key: o.signWith ?? privateKey, dsaEncoding: 'der' },
      )
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: cd,
          authenticatorData: b64url(data),
          signature: b64url(signature),
          userHandle: o.userHandle === undefined ? userHandle : o.userHandle,
        },
      }
    },
  }
}

export type SoftAuthenticator = ReturnType<typeof createSoftAuthenticator>

export const IDP_ISSUER = 'https://id.example.dev/application/o/hinomi'
export const IDP_CLIENT_ID = 'hinomi-client'
export const IDP_CLIENT_SECRET = 'idp-secret-fictional-0001'

export interface FakeIdp {
  fetch: typeof fetch
  /** Claims the next ID token carries on top of the defaults; `nonce` is taken from the login. */
  claims: Record<string, unknown>
  /** GitHub answers for the next GitHub login. */
  github: {
    login: string
    id: number
    emails: { email: string; verified: boolean; primary?: boolean }[]
  }
  /** Authorization requests seen, by state. */
  authorizations: Map<string, URLSearchParams>
  /** Requests made, as `METHOD url`. */
  calls: string[]
  /** Make the token endpoint fail once. */
  failToken: boolean
  /** Sign ID tokens with this key instead of the published one. */
  forgeWith: KeyObject | null
}

/**
 * An OpenID Connect provider and GitHub in one fetch stub. The authorization step is played by
 * the test: read `authorizations`, then call the callback with `code=<state>`. The token endpoint
 * checks the client secret and the PKCE verifier like a real provider.
 */
export function createFakeIdp(): FakeIdp {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const idp: FakeIdp = {
    claims: {},
    github: {
      login: 'kestrel-ops',
      id: 583231,
      emails: [{ email: 'ops@example.dev', verified: true, primary: true }],
    },
    authorizations: new Map(),
    calls: [],
    failToken: false,
    forgeWith: null,
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(answer(input, init)),
  }
  function answer(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = init?.method ?? 'GET'
    idp.calls.push(`${method} ${url.origin}${url.pathname}`)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.href === `${IDP_ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: `${IDP_ISSUER}/`,
        authorization_endpoint: 'https://id.example.dev/authorize',
        token_endpoint: 'https://id.example.dev/token',
        jwks_uri: 'https://id.example.dev/jwks',
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (url.href === 'https://id.example.dev/jwks') {
      return json({
        keys: [
          { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'k1', use: 'sig', alg: 'ES256' },
        ],
      })
    }
    if (url.href === 'https://id.example.dev/token' && method === 'POST') {
      const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : '')
      const expectedAuth = `Basic ${Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64')}`
      const headers = new Headers(init?.headers)
      const auth = idp.authorizations.get(form.get('code') ?? '')
      if (idp.failToken || headers.get('authorization') !== expectedAuth || !auth) {
        idp.failToken = false
        return json({ error: 'invalid_grant' }, 400)
      }
      const verifier = form.get('code_verifier') ?? ''
      if (
        createHash('sha256').update(verifier).digest('base64url') !== auth.get('code_challenge')
      ) {
        return json({ error: 'invalid_grant' }, 400)
      }
      const now = Math.floor(nowMs() / 1000)
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })))
      const payload = b64url(
        Buffer.from(
          JSON.stringify({
            iss: `${IDP_ISSUER}/`,
            aud: IDP_CLIENT_ID,
            sub: 'user-7f3a',
            email: 'ops@example.dev',
            email_verified: true,
            iat: now,
            exp: now + 300,
            nonce: auth.get('nonce'),
            ...idp.claims,
          }),
        ),
      )
      const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
        key: idp.forgeWith ?? privateKey,
        dsaEncoding: 'ieee-p1363',
      })
      return json({
        access_token: 'at-fictional',
        token_type: 'Bearer',
        id_token: `${header}.${payload}.${b64url(signature)}`,
      })
    }
    if (url.href === 'https://github.com/login/oauth/access_token' && method === 'POST') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        string
      >
      const auth = idp.authorizations.get(body.code ?? '')
      if (!auth || body.client_secret !== 'gh-secret-fictional-0001')
        return json({ error: 'bad_verification_code' })
      return json({ access_token: 'gho-fictional', token_type: 'bearer' })
    }
    if (url.href === 'https://api.github.com/user')
      return json({ login: idp.github.login, id: idp.github.id })
    if (url.href === 'https://api.github.com/user/emails') return json(idp.github.emails)
    return new Response('not found', { status: 404 })
  }
  return idp
}

/** Records an authorization redirect as the provider would see it, keyed by state. */
export function recordAuthorization(idp: FakeIdp, location: string): string {
  const params = new URL(location).searchParams
  const state = params.get('state') ?? ''
  idp.authorizations.set(state, params)
  return state
}
