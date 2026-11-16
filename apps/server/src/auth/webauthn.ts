import { constants, createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import type {
  PasskeyAssertion,
  PasskeyCreationOptions,
  PasskeyRegistration,
  PasskeyRequestOptions,
} from '@hinomi/shared'
import { CborError, decodeCbor, decodeCborExact, type CborValue } from './cbor.js'

/**
 * Passkeys (WebAuthn Level 3) without a library: the options Hinomi sends, and the checks on what
 * the browser sends back. Attestation is not asked for (`none`), so registration trusts the
 * authenticator the person chose, as a password manager or a security key would be. Only
 * discoverable credentials with user verification are accepted.
 * See https://www.w3.org/TR/webauthn-3/#sctn-registering-a-new-credential and
 * #sctn-verifying-assertion.
 */

export interface RelyingParty {
  /** The host name of HINOMI_AUTH_PUBLIC_URL. */
  id: string
  /** HINOMI_AUTH_PUBLIC_URL as an origin; the only origin a ceremony may come from. */
  origin: string
}

export const ES256 = -7
export const EDDSA = -8
export const RS256 = -257
const SUPPORTED_ALGS = [ES256, EDDSA, RS256] as const

/** How long the browser prompt may stay open; the challenge expires a little later. */
export const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40
const FLAG_ED = 0x80
const MIN_RSA_BITS = 2048

/** Why a ceremony was refused. The message is for the log; the browser gets a generic answer. */
export class WebAuthnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebAuthnError'
  }
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromB64url = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

export function creationOptions({
  rp,
  userHandle,
  challenge,
  exclude,
}: {
  rp: RelyingParty
  userHandle: string
  challenge: string
  exclude: readonly string[]
}): PasskeyCreationOptions {
  return {
    challenge,
    rp: { id: rp.id, name: 'Hinomi' },
    user: { id: userHandle, name: 'hinomi', displayName: `Hinomi (${rp.id})` },
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: exclude.map((id) => ({ type: 'public-key' as const, id })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
  }
}

export function requestOptions({
  rp,
  challenge,
}: {
  rp: RelyingParty
  challenge: string
}): PasskeyRequestOptions {
  return { challenge, rpId: rp.id, timeout: CEREMONY_TIMEOUT_MS, userVerification: 'required' }
}

export interface ClientData {
  type: string
  challenge: string
  origin: string
}

/**
 * Parses clientDataJSON and checks its type, origin and that it did not come from a cross origin
 * frame. The challenge is returned for the caller to look up and spend.
 */
export function readClientData(
  rp: RelyingParty,
  clientDataJSON: string,
  type: 'webauthn.create' | 'webauthn.get',
): ClientData {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new WebAuthnError('clientDataJSON is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WebAuthnError('clientDataJSON is not an object')
  }
  const data = parsed as Record<string, unknown>
  if (data.type !== type) throw new WebAuthnError(`expected ${type}`)
  if (typeof data.challenge !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.challenge)) {
    throw new WebAuthnError('missing challenge')
  }
  if (data.origin !== rp.origin) throw new WebAuthnError('origin does not match')
  if (data.crossOrigin === true) throw new WebAuthnError('cross origin ceremony')
  return { type, challenge: data.challenge, origin: data.origin }
}

interface AuthenticatorData {
  rpIdHash: Buffer
  flags: number
  signCount: number
  credential: { id: Uint8Array; key: Map<CborValue, CborValue> } | null
}

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError('authenticator data too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const flags = bytes[32] as number
  const signCount = view.getUint32(33)
  let pos = 37
  let credential: AuthenticatorData['credential'] = null
  try {
    if (flags & FLAG_AT) {
      if (bytes.length < pos + 18) throw new WebAuthnError('attested credential data too short')
      pos += 16 // AAGUID: not used without attestation
      const idLength = view.getUint16(pos)
      pos += 2
      if (idLength === 0 || idLength > 1023 || bytes.length < pos + idLength) {
        throw new WebAuthnError('bad credential id length')
      }
      const id = bytes.slice(pos, pos + idLength)
      pos += idLength
      const { value, end } = decodeCbor(bytes, pos)
      if (!(value instanceof Map)) throw new WebAuthnError('credential public key is not a map')
      pos = end
      credential = { id, key: value }
    }
    if (flags & FLAG_ED) pos = decodeCbor(bytes, pos).end
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError(error.message, { cause: error })
    throw error
  }
  if (pos !== bytes.length) throw new WebAuthnError('trailing bytes in authenticator data')
  return { rpIdHash: Buffer.from(bytes.subarray(0, 32)), flags, signCount, credential }
}

function checkFlagsAndRp(rp: RelyingParty, data: AuthenticatorData): void {
  if (!sha256(rp.id).equals(data.rpIdHash)) throw new WebAuthnError('rp id hash does not match')
  if (!(data.flags & FLAG_UP)) throw new WebAuthnError('user not present')
  if (!(data.flags & FLAG_UV)) throw new WebAuthnError('user not verified')
}

function bytesField(key: Map<CborValue, CborValue>, label: number): Uint8Array {
  const value = key.get(label)
  if (!(value instanceof Uint8Array)) throw new WebAuthnError(`COSE key misses ${label}`)
  return value
}

/** A COSE public key as a Node key object, with its algorithm. Only the three algorithms offered. */
export function coseToKey(cose: Map<CborValue, CborValue>): { key: KeyObject; algorithm: number } {
  const kty = cose.get(1)
  const alg = cose.get(3)
  try {
    if (kty === 2 && alg === ES256) {
      if (cose.get(-1) !== 1) throw new WebAuthnError('EC2 key is not P-256')
      const x = bytesField(cose, -2)
      const y = bytesField(cose, -3)
      if (x.length !== 32 || y.length !== 32) throw new WebAuthnError('bad P-256 coordinates')
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) },
        format: 'jwk',
      })
      return { key, algorithm: ES256 }
    }
    if (kty === 1 && alg === EDDSA) {
      if (cose.get(-1) !== 6) throw new WebAuthnError('OKP key is not Ed25519')
      const x = bytesField(cose, -2)
      if (x.length !== 32) throw new WebAuthnError('bad Ed25519 key')
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: b64url(x) },
        format: 'jwk',
      })
      return { key, algorithm: EDDSA }
    }
    if (kty === 3 && alg === RS256) {
      const n = bytesField(cose, -1)
      const e = bytesField(cose, -2)
      const key = createPublicKey({
        key: { kty: 'RSA', n: b64url(n), e: b64url(e) },
        format: 'jwk',
      })
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
      if (bits < MIN_RSA_BITS) throw new WebAuthnError('RSA key too short')
      return { key, algorithm: RS256 }
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    throw new WebAuthnError('unreadable public key', { cause: error })
  }
  throw new WebAuthnError('unsupported key type or algorithm')
}

export interface VerifiedRegistration {
  credentialId: string
  /** SPKI DER, base64. */
  publicKey: string
  algorithm: number
  signCount: number
  transports: string[] | null
}

/**
 * Checks a create() answer whose clientData was read with readClientData and whose challenge the
 * caller has matched and spent.
 */
export function verifyRegistration(
  rp: RelyingParty,
  registration: PasskeyRegistration,
): VerifiedRegistration {
  if (registration.id !== registration.rawId) throw new WebAuthnError('id and rawId differ')
  let attestation: CborValue
  try {
    attestation = decodeCborExact(fromB64url(registration.response.attestationObject))
  } catch (error) {
    if (error instanceof CborError) throw new WebAuthnError(error.message, { cause: error })
    throw error
  }
  if (!(attestation instanceof Map)) throw new WebAuthnError('attestation object is not a map')
  const authData = attestation.get('authData')
  if (!(authData instanceof Uint8Array)) throw new WebAuthnError('missing authData')
  const data = parseAuthenticatorData(authData)
  checkFlagsAndRp(rp, data)
  if (!data.credential) throw new WebAuthnError('no attested credential')
  const credentialId = b64url(data.credential.id)
  if (credentialId !== registration.id) throw new WebAuthnError('credential id does not match')
  const { key, algorithm } = coseToKey(data.credential.key)
  return {
    credentialId,
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    algorithm,
    signCount: data.signCount,
    transports: registration.response.transports ?? null,
  }
}

export interface StoredPasskey {
  publicKey: string
  algorithm: number
  signCount: number
}

/**
 * Checks a get() answer for a stored passkey: rp id, presence and verification flags, the
 * signature over authenticatorData and the client data hash, and the signature counter.
 * @returns the new counter to store.
 */
export function verifyAssertion(
  rp: RelyingParty,
  assertion: PasskeyAssertion,
  stored: StoredPasskey,
  expectedUserHandle: string,
): { signCount: number } {
  if (assertion.id !== assertion.rawId) throw new WebAuthnError('id and rawId differ')
  const handle = assertion.response.userHandle
  if (handle && handle !== expectedUserHandle) throw new WebAuthnError('user handle differs')
  const authData = fromB64url(assertion.response.authenticatorData)
  const data = parseAuthenticatorData(authData)
  checkFlagsAndRp(rp, data)

  const signed = Buffer.concat([authData, sha256(fromB64url(assertion.response.clientDataJSON))])
  const signature = fromB64url(assertion.response.signature)
  const key = createPublicKey({
    key: Buffer.from(stored.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
  let ok: boolean
  try {
    if (stored.algorithm === ES256) {
      ok = verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)
    } else if (stored.algorithm === RS256) {
      ok = verify('sha256', signed, { key, padding: constants.RSA_PKCS1_PADDING }, signature)
    } else if (stored.algorithm === EDDSA) {
      ok = verify(null, signed, key, signature)
    } else {
      throw new WebAuthnError('unsupported stored algorithm')
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error
    ok = false
  }
  if (!ok) throw new WebAuthnError('bad signature')

  // Synced passkeys always report 0. A counter that goes nowhere while the stored one moved, or
  // goes back, means a cloned authenticator.
  if ((data.signCount !== 0 || stored.signCount !== 0) && data.signCount <= stored.signCount) {
    throw new WebAuthnError('signature counter did not increase')
  }
  return { signCount: data.signCount }
}
