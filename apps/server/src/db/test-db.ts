import { loadConfig } from '../config.js'
import { createSecretBox } from '../crypto/secret-box.js'
import { createRepositories } from '../repository/index.js'
import { openDatabase } from './client.js'

/** Test helper: a migrated in-memory database. */
export function createTestDatabase() {
  return openDatabase({ file: ':memory:', migrationsDir: loadConfig({}).migrationsDir })
}

export const TEST_SECRET = 'test-secret-key-not-for-production'

/** Test helper: repositories on a migrated in-memory database. */
export function createTestRepositories({ withSecret = true } = {}) {
  const handle = createTestDatabase()
  const box = withSecret ? createSecretBox(TEST_SECRET) : null
  return { handle, repos: createRepositories(handle.db, box) }
}
