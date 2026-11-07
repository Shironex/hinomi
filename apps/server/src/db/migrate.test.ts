import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'
import { createTestDatabase } from './test-db.js'

const TABLES = [
  'advisories',
  'deployment_repo_overrides',
  'deployments',
  'finding_events',
  'findings',
  'fix_plans',
  'fix_runs',
  'repos',
  'scan_runs',
  'settings',
  'sources',
]

describe('migrations', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('create every table on an empty database', () => {
    const handle = createTestDatabase()
    const { sqlite } = handle
    const tables = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
      )
      .pluck()
      .all()
    expect(tables).toEqual(TABLES)
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    handle.close()
  })

  it('create the database file and its folder, and are idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-db-'))
    dirs.push(dir)
    const file = join(dir, 'nested', 'hinomi.db')
    const { migrationsDir } = loadConfig({})

    const first = openDatabase({ file, migrationsDir })
    expect(existsSync(file)).toBe(true)
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    first.sqlite.prepare("insert into settings (key, value) values ('k', '1')").run()
    first.close()

    const second = openDatabase({ file, migrationsDir })
    const applied = second.sqlite.prepare('select count(*) from __drizzle_migrations').pluck().get()
    expect(applied).toBe(readMigrationFiles({ migrationsFolder: migrationsDir }).length)
    expect(second.sqlite.prepare('select value from settings').pluck().get()).toBe('1')
    second.close()
  })
})
