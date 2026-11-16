import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cborEncode, createSoftAuthenticator } from './testing.js'
import {
  coseToKey,
  creationOptions,
  EDDSA,
  readClientData,
  requestOptions,
  RS256,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from './webauthn.js'

const rp = { id: 'hinomi.example.dev', origin: 'https://hinomi.example.dev' }
const HANDLE = 'aGlub21pLXVzZXItaGFuZGxlLWZpY3Rpb25hbA'

function registered() {
  const authenticator = createSoftAuthenticator({ origin: rp.origin })
  const options = creationOptions({ rp, userHandle: HANDLE, challenge: 'c1', exclude: [] })
  const stored = verifyRegistration(rp, authenticator.register(options))
  return { authenticator, stored }
}

describe('creationOptions', () => {
  it('asks for a discoverable, user verified credential without attestation', () => {
    expect(creationOptions({ rp, userHandle: HANDLE, challenge: 'c1', exclude: ['x'] })).toEqual({
      challenge: 'c1',
      rp: { id: 'hinomi.example.dev', name: 'Hinomi' },
      user: { id: HANDLE, name: 'hinomi', displayName: 'Hinomi (hinomi.example.dev)' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 300000,
      excludeCredentials: [{ type: 'public-key', id: 'x' }],
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
    })
  })
})

describe('readClientData', () => {
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url')

  it('returns the challenge of a matching ceremony', () => {
    expect(
      readClientData(
        rp,
        encode({ type: 'webauthn.get', challenge: 'abc', origin: rp.origin }),
        'webauthn.get',
      ),
    ).toEqual({ type: 'webauthn.get', challenge: 'abc', origin: rp.origin })
  })

  it.each([
    ['another type', { type: 'webauthn.create', challenge: 'abc', origin: rp.origin }],
    [
      'another origin',
      { type: 'webauthn.get', challenge: 'abc', origin: 'https://evil.example.dev' },
    ],
    [
      'a cross origin frame',
      { type: 'webauthn.get', challenge: 'abc', origin: rp.origin, crossOrigin: true },
    ],
    ['no challenge', { type: 'webauthn.get', origin: rp.origin }],
  ])('refuses %s', (_name, data) => {
    expect(() => readClientData(rp, encode(data), 'webauthn.get')).toThrow(WebAuthnError)
  })
})

describe('verifyRegistration', () => {
  it('stores the public key as SPKI with its algorithm', () => {
    const { authenticator, stored } = registered()
    expect(stored).toMatchObject({
      credentialId: authenticator.credentialId,
      algorithm: -7,
      signCount: 0,
    })
    expect(Buffer.from(stored.publicKey, 'base64').length).toBeGreaterThan(80)
  })

  it.each([
    ['no user verification', { flags: 0x41 }],
    ['no user presence', { flags: 0x44 }],
    ['another rp id', { rpId: 'evil.example.dev' }],
  ])('refuses %s', (_name, overrides) => {
    const authenticator = createSoftAuthenticator({ origin: rp.origin })
    const options = creationOptions({ rp, userHandle: HANDLE, challenge: 'c1', exclude: [] })
    expect(() => verifyRegistration(rp, authenticator.register(options, overrides))).toThrow(
      WebAuthnError,
    )
  })

  it('refuses a credential id that differs from the attested one', () => {
    const authenticator = createSoftAuthenticator({ origin: rp.origin })
    const options = creationOptions({ rp, userHandle: HANDLE, challenge: 'c1', exclude: [] })
    const reg = authenticator.register(options)
    expect(() => verifyRegistration(rp, { ...reg, id: 'AAAA', rawId: 'AAAA' })).toThrow(
      'credential id',
    )
  })
})

describe('verifyAssertion', () => {
  it('accepts a good signature and returns the counter', () => {
    const { authenticator, stored } = registered()
    const assertion = authenticator.assert(requestOptions({ rp, challenge: 'c2' }))
    expect(verifyAssertion(rp, assertion, stored, HANDLE)).toEqual({ signCount: 1 })
  })

  it('refuses another user handle', () => {
    const { authenticator, stored } = registered()
    const assertion = authenticator.assert(requestOptions({ rp, challenge: 'c2' }), {
      userHandle: 'other',
    })
    expect(() => verifyAssertion(rp, assertion, stored, HANDLE)).toThrow('user handle')
  })

  it('accepts counters that stay at zero (synced passkeys)', () => {
    const { authenticator, stored } = registered()
    const assertion = authenticator.assert(requestOptions({ rp, challenge: 'c2' }), {
      signCount: 0,
    })
    expect(verifyAssertion(rp, assertion, stored, HANDLE)).toEqual({ signCount: 0 })
  })

  it('refuses a counter that stopped after moving', () => {
    const { authenticator, stored } = registered()
    const assertion = authenticator.assert(requestOptions({ rp, challenge: 'c2' }), {
      signCount: 5,
    })
    expect(() => verifyAssertion(rp, assertion, { ...stored, signCount: 5 }, HANDLE)).toThrow(
      'counter',
    )
  })
})

describe('coseToKey', () => {
  const b = (value: string | undefined) => Buffer.from(value ?? '', 'base64url')

  it('reads Ed25519 keys', () => {
    const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
    const cose = new Map<number, number | Uint8Array>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, b(jwk.x)],
    ])
    expect(coseToKey(cose).algorithm).toBe(EDDSA)
  })

  it('reads RSA keys of 2048 bits and refuses shorter ones', () => {
    const rsa = (bits: number) => {
      const jwk = generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({
        format: 'jwk',
      })
      return new Map<number, number | Uint8Array>([
        [1, 3],
        [3, -257],
        [-1, b(jwk.n)],
        [-2, b(jwk.e)],
      ])
    }
    expect(coseToKey(rsa(2048)).algorithm).toBe(RS256)
    expect(() => coseToKey(rsa(1024))).toThrow('too short')
  })

  it('refuses an algorithm Hinomi did not offer', () => {
    const cose = new Map<number, number>([
      [1, 2],
      [3, -35],
    ])
    expect(() => coseToKey(cose)).toThrow('unsupported')
  })

  it('is fed by CBOR the authenticator wrote', () => {
    expect(cborEncode(new Map([[1, 2]]))).toEqual(new Uint8Array([0xa1, 0x01, 0x02]))
  })
})
