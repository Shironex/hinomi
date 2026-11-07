import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'

interface Journal {
  entries: { idx: number; tag: string }[]
}

describe('runtime pins migration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('adds the pins table to a populated database and keeps its rows', () => {
    const { migrationsDir } = loadConfig({})
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-mig-'))
    dirs.push(dir)
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as Journal
    const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_runtime_pins'))
    if (upTo < 1) throw new Error('no runtime_pins migration')
    expect(upTo).toBe(journal.entries.length - 1)
    const entries = journal.entries.slice(0, upTo)
    const old = join(dir, 'old')
    mkdirSync(join(old, 'meta'), { recursive: true })
    for (const entry of entries) {
      cpSync(join(migrationsDir, `${entry.tag}.sql`), join(old, `${entry.tag}.sql`))
    }
    writeFileSync(join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))

    const file = join(dir, 'hinomi.db')
    const before = openDatabase({ file, migrationsDir: old })
    before.sqlite.prepare("insert into repos (owner, name) values ('kestrel-co', 'harbor')").run()
    before.close()

    const after = openDatabase({ file, migrationsDir })
    expect(after.sqlite.prepare('select count(*) from repos').pluck().get()).toBe(1)
    after.sqlite
      .prepare(
        "insert into runtime_pins (repo_id, ref, runtime, source, path, raw, kind, scope, scanned_at) values (1, 'main', 'node', 'nvmrc', '.nvmrc', '22', 'exact', 'dev', 0)",
      )
      .run()
    after.close()
  })
})
