import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  db: Db
  /** The underlying better-sqlite3 connection, for pragmas and closing. */
  sqlite: Database.Database
  close(): void
}

export interface OpenDatabaseOptions {
  /** Path of the database file, or `:memory:` for tests. */
  file: string
  /** Folder with the drizzle-kit migrations. When set, pending migrations run before returning. */
  migrationsDir?: string
}

/**
 * Opens (and creates when missing) the SQLite database, sets the pragmas the
 * app relies on and applies pending migrations.
 *
 * better-sqlite3 is synchronous, so every query and transaction runs to the
 * end before anything else touches the connection: no interleaving between
 * concurrent requests inside a transaction.
 */
export function openDatabase({ file, migrationsDir }: OpenDatabaseOptions): DatabaseHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })

  const sqlite = new Database(file)
  // WAL lets the API read while a scan writes; NORMAL sync is safe with WAL.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  const db = drizzle(sqlite, { schema })
  if (migrationsDir) migrate(db, { migrationsFolder: migrationsDir })

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  }
}
