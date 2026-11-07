import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'

interface Journal {
  entries: { idx: number; tag: string }[]
}

describe('guard findings and check overrides migrations', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps existing findings, with the guard columns empty, and adds the overrides table', () => {
    const { migrationsDir } = loadConfig({})
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-mig-'))
    dirs.push(dir)

    // A migrations folder that stops before guard_findings: the schema of a v0.2 install.
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as Journal
    const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_guard_findings'))
    if (upTo < 1) throw new Error('no guard_findings migration')
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
    before.sqlite
      .prepare(
        `insert into findings (dedupe_key, kind, blind_spot_type, repo_id, state, first_seen_at, last_seen_at)
         values ('blind:archived_deployed:repo:1', 'blind_spot', 'archived_deployed', 1, 'accepted', 1, 1)`,
      )
      .run()
    before.close()

    const after = openDatabase({ file, migrationsDir })
    const row = after.sqlite
      .prepare(
        'select kind, state, guard_check, guard_level, evidence, release_tag from findings where id = 1',
      )
      .get()
    expect(row).toEqual({
      kind: 'blind_spot',
      state: 'accepted',
      guard_check: null,
      guard_level: null,
      evidence: null,
      release_tag: null,
    })

    const insert = after.sqlite.prepare(
      'insert into check_overrides ("check", repo_id, reason) values (\'archived_deployed\', 1, ?)',
    )
    insert.run('frozen on purpose')
    // One override per check and subject, even though the other id is null.
    expect(() => insert.run('again')).toThrow(/UNIQUE/)
    after.sqlite.prepare('delete from repos where id = 1').run()
    expect(after.sqlite.prepare('select count(*) as n from check_overrides').get()).toEqual({
      n: 0,
    })
    after.close()
  })
})
