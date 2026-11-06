import type { Config } from './config.js'
import { createSecretBox, type SecretBox } from './crypto/secret-box.js'
import { openDatabase, type DatabaseHandle } from './db/client.js'
import { createRepositories, type Repositories } from './repository/index.js'

export interface Storage {
  database: DatabaseHandle
  repositories: Repositories
  /** null when HINOMI_SECRET_KEY is not set: tokens cannot be stored. */
  secretBox: SecretBox | null
  close(): void
}

/** Opens the database in the data dir, runs migrations and builds the repositories. */
export function openStorage(
  config: Pick<Config, 'databaseFile' | 'migrationsDir' | 'secretKey'>,
): Storage {
  const database = openDatabase({ file: config.databaseFile, migrationsDir: config.migrationsDir })
  const secretBox = config.secretKey ? createSecretBox(config.secretKey) : null
  return {
    database,
    repositories: createRepositories(database.db, secretBox),
    secretBox,
    close: () => database.close(),
  }
}
