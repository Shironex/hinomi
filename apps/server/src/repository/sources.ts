import type { SourceAuth, SourceKind } from '@hinomi/shared'
import { asc, eq } from 'drizzle-orm'
import { SecretKeyMissingError, type SecretBox } from '../crypto/secret-box.js'
import type { Db } from '../db/client.js'
import { sources, type SourceRow } from '../db/schema.js'
import { releaseSource } from './repo-sources.js'
import { currentTime } from '@hinomi/shared'

/**
 * A source as the rest of the app sees it. The secret is never part of it:
 * only `hasToken` says whether one is stored. Safe to log and to send to the
 * browser.
 */
export interface Source {
  id: number
  kind: SourceKind
  name: string
  baseUrl: string | null
  enabled: boolean
  /** How the source signs in. Rows from before GitHub App support read as `token`. */
  auth: SourceAuth
  /** GitHub App ID or Client ID, null for token auth. */
  appId: string | null
  /** GitHub App installation ID, null for token auth. */
  installationId: string | null
  /** The secret is stored: the token, or the private key of a GitHub App. */
  hasToken: boolean
  lastOkAt: Date | null
  lastErrorAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateSourceInput {
  kind: SourceKind
  name: string
  baseUrl?: string | null
  enabled?: boolean
  /**
   * Plain secret (the token, or the private key PEM of a GitHub App); encrypted
   * before it is written. Requires HINOMI_SECRET_KEY.
   */
  token?: string
  auth?: SourceAuth
  appId?: string | null
  installationId?: string | null
}

export interface UpdateSourceInput {
  name?: string
  baseUrl?: string | null
  enabled?: boolean
  auth?: SourceAuth
  appId?: string | null
  installationId?: string | null
}

export function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    auth: row.auth,
    appId: row.appId,
    installationId: row.installationId,
    hasToken: row.tokenEncrypted !== null,
    lastOkAt: row.lastOkAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type SourcesRepository = ReturnType<typeof createSourcesRepository>

/**
 * @param secretBox null when HINOMI_SECRET_KEY is not set. Everything works
 * except storing or reading a token, which throws SecretKeyMissingError.
 */
export function createSourcesRepository(db: Db, secretBox: SecretBox | null) {
  function requireBox(): SecretBox {
    if (!secretBox) throw new SecretKeyMissingError()
    return secretBox
  }

  function get(id: number): Source | undefined {
    const row = db.select().from(sources).where(eq(sources.id, id)).get()
    return row && toSource(row)
  }

  return {
    /** True when HINOMI_SECRET_KEY is set, so tokens can be stored. */
    canStoreTokens: secretBox !== null,

    list(): Source[] {
      return db.select().from(sources).orderBy(asc(sources.id)).all().map(toSource)
    },

    get,

    listByKind(kind: SourceKind): Source[] {
      return db
        .select()
        .from(sources)
        .where(eq(sources.kind, kind))
        .orderBy(asc(sources.id))
        .all()
        .map(toSource)
    },

    /** @throws SecretKeyMissingError when a token is given without HINOMI_SECRET_KEY. */
    create(input: CreateSourceInput): Source {
      const tokenEncrypted = input.token === undefined ? null : requireBox().encrypt(input.token)
      const row = db
        .insert(sources)
        .values({
          kind: input.kind,
          name: input.name,
          baseUrl: input.baseUrl ?? null,
          enabled: input.enabled ?? true,
          tokenEncrypted,
          auth: input.auth ?? 'token',
          appId: input.appId ?? null,
          installationId: input.installationId ?? null,
        })
        .returning()
        .get()
      return toSource(row)
    },

    /** Switching a source off moves the repos it reads to another source that sees them. */
    update(id: number, input: UpdateSourceInput): Source | undefined {
      return db.transaction(() => {
        const row = db.update(sources).set(input).where(eq(sources.id, id)).returning().get()
        if (row && input.enabled === false) releaseSource(db, id)
        return row && toSource(row)
      })
    },

    /**
     * Encrypts and stores the token, replacing any previous one.
     * @throws SecretKeyMissingError when HINOMI_SECRET_KEY is not set.
     */
    setToken(id: number, token: string): boolean {
      const tokenEncrypted = requireBox().encrypt(token)
      const result = db.update(sources).set({ tokenEncrypted }).where(eq(sources.id, id)).run()
      return result.changes > 0
    },

    clearToken(id: number): boolean {
      return db.transaction(() => {
        const result = db
          .update(sources)
          .set({ tokenEncrypted: null })
          .where(eq(sources.id, id))
          .run()
        if (result.changes > 0) releaseSource(db, id)
        return result.changes > 0
      })
    },

    /**
     * Decrypted secret for the source clients: the token, or for a GitHub App
     * source the private key PEM. Never log it or put it in a
     * response. Returns null when no token is stored.
     * @throws SecretKeyMissingError when a token is stored but HINOMI_SECRET_KEY is not set.
     * @throws SecretDecryptError when the stored value was tampered with or the key changed.
     */
    getToken(id: number): string | null {
      const row = db
        .select({ tokenEncrypted: sources.tokenEncrypted })
        .from(sources)
        .where(eq(sources.id, id))
        .get()
      if (!row?.tokenEncrypted) return null
      return requireBox().decrypt(row.tokenEncrypted)
    },

    /** Records a successful sync and clears the last error. */
    markOk(id: number, at: Date = currentTime()): void {
      db.update(sources)
        .set({ lastOkAt: at, lastError: null, lastErrorAt: null })
        .where(eq(sources.id, id))
        .run()
    },

    /** Records a failed sync. The message is shown in the UI: never include a token in it. */
    markError(id: number, message: string, at: Date = currentTime()): void {
      db.update(sources)
        .set({ lastErrorAt: at, lastError: message })
        .where(eq(sources.id, id))
        .run()
    },

    /**
     * Deletes the source and, through cascades, its deployments. The repos it read move to
     * another GitHub source that sees them, or are left with no reader; their history stays.
     */
    remove(id: number): boolean {
      return db.transaction(() => {
        releaseSource(db, id)
        return db.delete(sources).where(eq(sources.id, id)).run().changes > 0
      })
    },
  }
}
