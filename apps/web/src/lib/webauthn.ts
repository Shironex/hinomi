import type {
  PasskeyAssertion,
  PasskeyCreationOptions,
  PasskeyRegistration,
  PasskeyRequestOptions,
} from '@hinomi/shared'

/**
 * The browser side of passkeys: the server's JSON options become what navigator.credentials
 * takes, and the credential it returns becomes JSON again. Written out by hand rather than with
 * PublicKeyCredential.parseCreationOptionsFromJSON, which older Safari and Firefox lack.
 */

function fromB64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function toB64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** True when this browser can use passkeys at all (a secure context with WebAuthn). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window
}

/** Thrown when the person closes the prompt or the browser refuses; the message is for people. */
export class PasskeyCancelled extends Error {
  constructor(options?: ErrorOptions) {
    super('The passkey prompt was closed or timed out. Try again.', options)
    this.name = 'PasskeyCancelled'
  }
}

async function call<T>(run: () => Promise<Credential | null>): Promise<T> {
  let credential: Credential | null
  try {
    credential = await run()
  } catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) {
      throw new PasskeyCancelled({ cause: error })
    }
    throw error
  }
  if (!credential) throw new PasskeyCancelled()
  return credential as T
}

/** Registers a new passkey with the options from the server. */
export async function createPasskey(options: PasskeyCreationOptions): Promise<PasskeyRegistration> {
  const credential = await call<PublicKeyCredential>(() =>
    navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: fromB64url(options.challenge),
        user: { ...options.user, id: fromB64url(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((c) => ({
          ...c,
          id: fromB64url(c.id),
        })),
      },
    }),
  )
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      attestationObject: toB64url(response.attestationObject),
      transports:
        typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    },
  }
}

/** Signs the server's challenge with a passkey the person picks. */
export async function signWithPasskey(options: PasskeyRequestOptions): Promise<PasskeyAssertion> {
  const credential = await call<PublicKeyCredential>(() =>
    navigator.credentials.get({
      publicKey: { ...options, challenge: fromB64url(options.challenge) },
    }),
  )
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
      userHandle: response.userHandle ? toB64url(response.userHandle) : null,
    },
  }
}

export const base64url = { fromB64url, toB64url }
