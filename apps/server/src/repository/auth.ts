import { and, asc, count, desc, eq, inArray, lte, ne, or } from 'drizzle-orm'
import type { AuthMethod, PasskeyOwnerMethod } from '@hinomi/shared'
import type { Db } from '../db/client.js'
import {
  authPasskeys,
  authSessions,
  type AuthPasskeyRow,
  type AuthSessionRow,
} from '../db/schema.js'

export interface NewSession {
  tokenHash: string
  publicId: string
  csrfToken: string
  method: AuthMethod
  subject: string
  passkeyId: number | null
  createdAt: Date
  expiresAt: Date
  ip: string | null
  userAgent: string | null
}

export interface NewPasskey {
  credentialId: string
  publicKey: string
  algorithm: number
  signCount: number
  name: string
  transports: string[] | null
  ownerMethod: PasskeyOwnerMethod
  ownerSubject: string
}

export type AuthRepository = ReturnType<typeof createAuthRepository>

/**
 * Sessions and passkeys of the built in login. Sessions are looked up by the SHA-256 of the cookie
 * token (auth/sessions.ts hashes it); nothing here sees a token.
 */
export function createAuthRepository(db: Db) {
  return {
    sessions: {
      create(input: NewSession): AuthSessionRow {
        return db
          .insert(authSessions)
          .values({ ...input, lastSeenAt: input.createdAt })
          .returning()
          .get()
      },

      byTokenHash(tokenHash: string): AuthSessionRow | undefined {
        return db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).get()
      },

      touch(tokenHash: string, at: Date): void {
        db.update(authSessions)
          .set({ lastSeenAt: at })
          .where(eq(authSessions.tokenHash, tokenHash))
          .run()
      },

      list(): AuthSessionRow[] {
        return db.select().from(authSessions).orderBy(desc(authSessions.lastSeenAt)).all()
      },

      removeByTokenHash(tokenHash: string): boolean {
        return (
          db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).run().changes > 0
        )
      },

      removeByPublicId(publicId: string): AuthSessionRow | undefined {
        return db.delete(authSessions).where(eq(authSessions.publicId, publicId)).returning().get()
      },

      /** Every session but the one given; returns how many ended. */
      removeOthers(keepTokenHash: string): number {
        return db.delete(authSessions).where(ne(authSessions.tokenHash, keepTokenHash)).run()
          .changes
      },

      removeAll(): number {
        return db.delete(authSessions).run().changes
      },

      removeByPasskey(passkeyId: number): number {
        return db.delete(authSessions).where(eq(authSessions.passkeyId, passkeyId)).run().changes
      },

      /** Sessions past their absolute end, or idle since before `idleBefore`. */
      removeExpired(now: Date, idleBefore: Date): number {
        return db
          .delete(authSessions)
          .where(or(lte(authSessions.expiresAt, now), lte(authSessions.lastSeenAt, idleBefore)))
          .run().changes
      },

      /** Ends the sessions of these methods whose subject `keep` refuses (a removed allow rule). */
      removeWhere(methods: AuthMethod[], keep: (subject: string) => boolean): number {
        const rows = db
          .select({ tokenHash: authSessions.tokenHash, subject: authSessions.subject })
          .from(authSessions)
          .where(inArray(authSessions.method, methods))
          .all()
        const drop = rows.filter((row) => !keep(row.subject)).map((row) => row.tokenHash)
        if (drop.length === 0) return 0
        return db.delete(authSessions).where(inArray(authSessions.tokenHash, drop)).run().changes
      },
    },

    passkeys: {
      list(): AuthPasskeyRow[] {
        return db.select().from(authPasskeys).orderBy(asc(authPasskeys.id)).all()
      },

      count(): number {
        return db.select({ n: count() }).from(authPasskeys).get()?.n ?? 0
      },

      byCredentialId(credentialId: string): AuthPasskeyRow | undefined {
        return db
          .select()
          .from(authPasskeys)
          .where(eq(authPasskeys.credentialId, credentialId))
          .get()
      },

      /** @returns null when the credential is registered already. */
      create(input: NewPasskey): AuthPasskeyRow | null {
        return db.transaction(() => {
          if (
            db
              .select({ id: authPasskeys.id })
              .from(authPasskeys)
              .where(eq(authPasskeys.credentialId, input.credentialId))
              .get()
          ) {
            return null
          }
          return db.insert(authPasskeys).values(input).returning().get()
        })
      },

      /**
       * Stores the new signature counter after a login, only if it still holds the value the
       * login read, so two logins racing with one counter value cannot both pass.
       */
      recordUse(id: number, expectedCount: number, signCount: number, at: Date): boolean {
        return (
          db
            .update(authPasskeys)
            .set({ signCount, lastUsedAt: at })
            .where(and(eq(authPasskeys.id, id), eq(authPasskeys.signCount, expectedCount)))
            .run().changes > 0
        )
      },

      remove(id: number): AuthPasskeyRow | undefined {
        return db.delete(authPasskeys).where(eq(authPasskeys.id, id)).returning().get()
      },

      removeAll(): number {
        return db.delete(authPasskeys).run().changes
      },
    },
  }
}
