import { asc, eq } from 'drizzle-orm'
import { SecretKeyMissingError, type SecretBox } from '../crypto/secret-box.js'
import type { Db } from '../db/client.js'
import { registryCredentials, type RegistryCredentialRow } from '../db/schema.js'

/**
 * A registry credential as the rest of the app sees it: host and user name, and whether a secret
 * is stored. Safe to log and to send to the browser.
 */
export interface RegistryCredential {
  id: number
  host: string
  username: string
  secretSet: boolean
  createdAt: Date
  updatedAt: Date
}

/** The user name and the decrypted secret, for the registry client only. Never log it. */
export interface RegistryLogin {
  username: string
  secret: string
}

function toCredential(row: RegistryCredentialRow): RegistryCredential {
  return {
    id: row.id,
    host: row.host,
    username: row.username,
    secretSet: row.secretEncrypted !== '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type RegistryCredentialsRepository = ReturnType<typeof createRegistryCredentialsRepository>

/**
 * Credentials for private OCI registries, the secret encrypted with HINOMI_SECRET_KEY in the same
 * box and format as source tokens. Hosts are stored normalized (normalizeRegistryHost) and matched
 * exactly.
 *
 * @param secretBox null when HINOMI_SECRET_KEY is not set: credentials can be listed and removed,
 * not stored or read.
 */
export function createRegistryCredentialsRepository(db: Db, secretBox: SecretBox | null) {
  function requireBox(): SecretBox {
    if (!secretBox) throw new SecretKeyMissingError()
    return secretBox
  }

  const rowByHost = (host: string) =>
    db.select().from(registryCredentials).where(eq(registryCredentials.host, host)).get()

  return {
    /** True when HINOMI_SECRET_KEY is set, so secrets can be stored. */
    canStoreSecrets: secretBox !== null,

    list(): RegistryCredential[] {
      return db
        .select()
        .from(registryCredentials)
        .orderBy(asc(registryCredentials.host))
        .all()
        .map(toCredential)
    },

    get(id: number): RegistryCredential | undefined {
      const row = db.select().from(registryCredentials).where(eq(registryCredentials.id, id)).get()
      return row && toCredential(row)
    },

    /**
     * @param host already normalized.
     * @returns null when the host has a credential already.
     * @throws SecretKeyMissingError without HINOMI_SECRET_KEY.
     */
    create(input: { host: string; username: string; secret: string }): RegistryCredential | null {
      const secretEncrypted = requireBox().encrypt(input.secret)
      return db.transaction(() => {
        if (rowByHost(input.host)) return null
        const row = db
          .insert(registryCredentials)
          .values({ host: input.host, username: input.username, secretEncrypted })
          .returning()
          .get()
        return toCredential(row)
      })
    },

    /**
     * Changes the user name, or replaces the secret. The host never changes.
     * @throws SecretKeyMissingError when a secret is given without HINOMI_SECRET_KEY.
     */
    update(
      id: number,
      input: { username?: string; secret?: string },
    ): RegistryCredential | undefined {
      const set: Partial<Pick<RegistryCredentialRow, 'username' | 'secretEncrypted'>> = {}
      if (input.username !== undefined) set.username = input.username
      if (input.secret !== undefined) set.secretEncrypted = requireBox().encrypt(input.secret)
      const row = db
        .update(registryCredentials)
        .set(set)
        .where(eq(registryCredentials.id, id))
        .returning()
        .get()
      return row && toCredential(row)
    },

    remove(id: number): boolean {
      return db.delete(registryCredentials).where(eq(registryCredentials.id, id)).run().changes > 0
    },

    /**
     * The login stored for exactly this host (normalized, port included), decrypted; null when none.
     * @throws SecretKeyMissingError when one is stored but HINOMI_SECRET_KEY is not set.
     * @throws SecretDecryptError when it was tampered with or the key changed.
     */
    loginFor(host: string): RegistryLogin | null {
      const row = rowByHost(host)
      if (!row) return null
      return { username: row.username, secret: requireBox().decrypt(row.secretEncrypted) }
    },
  }
}
