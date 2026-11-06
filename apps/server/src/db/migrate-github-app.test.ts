import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'

interface Journal {
  entries: { idx: number; tag: string }[]
}

describe('github app migration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps sources stored before it working as token sources', () => {
    const { migrationsDir } = loadConfig({})
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-mig-'))
    dirs.push(dir)

    // A migrations folder that stops at the first one: the schema of an older install.
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as Journal
    const old = join(dir, 'old')
    mkdirSync(join(old, 'meta'), { recursive: true })
    const first = journal.entries[0]
    if (!first) throw new Error('no migrations')
    cpSync(join(migrationsDir, `${first.tag}.sql`), join(old, `${first.tag}.sql`))
    writeFileSync(
      join(old, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: [first] }),
    )

    const file = join(dir, 'hinomi.db')
    const before = openDatabase({ file, migrationsDir: old })
    before.sqlite
      .prepare(
        "insert into sources (kind, name, token_encrypted) values ('github', 'kestrel', 'v1.sealed')",
      )
      .run()
    before.close()

    const after = openDatabase({ file, migrationsDir })
    const row = after.sqlite
      .prepare('select auth, app_id, installation_id, token_encrypted from sources')
      .get()
    expect(row).toEqual({
      auth: 'token',
      app_id: null,
      installation_id: null,
      token_encrypted: 'v1.sealed',
    })
    after.close()
  })
})
