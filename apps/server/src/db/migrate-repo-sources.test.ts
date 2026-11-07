import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'

interface Journal {
  entries: { idx: number; tag: string }[]
}

describe('repo sources migration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('gives every repo the GitHub source it was read through before', () => {
    const { migrationsDir } = loadConfig({})
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-mig-'))
    dirs.push(dir)

    // A migrations folder that stops before repo_sources: the schema of a v0.1 install.
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as Journal
    const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_repo_sources'))
    if (upTo < 1) throw new Error('no repo_sources migration')
    const entries = journal.entries.slice(0, upTo)
    const old = join(dir, 'old')
    mkdirSync(join(old, 'meta'), { recursive: true })
    for (const entry of entries) {
      cpSync(join(migrationsDir, `${entry.tag}.sql`), join(old, `${entry.tag}.sql`))
    }
    writeFileSync(join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))

    const file = join(dir, 'hinomi.db')
    const before = openDatabase({ file, migrationsDir: old })
    const insert = before.sqlite.prepare(
      'insert into sources (kind, name, enabled, token_encrypted) values (?, ?, ?, ?)',
    )
    insert.run('github', 'switched-off', 0, 'v1.sealed')
    insert.run('github', 'no-token', 1, null)
    insert.run('github', 'kestrel-co', 1, 'v1.sealed')
    insert.run('github', 'kestrel-labs', 1, 'v1.sealed')
    before.sqlite.prepare("insert into repos (owner, name) values ('kestrel-co', 'harbor')").run()
    before.close()

    const after = openDatabase({ file, migrationsDir })
    const row = after.sqlite
      .prepare(
        'select s.name as source, r.source_override_id as override from repos r join sources s on s.id = r.source_id',
      )
      .get()
    expect(row).toEqual({ source: 'kestrel-co', override: null })
    after.close()
  })
})
