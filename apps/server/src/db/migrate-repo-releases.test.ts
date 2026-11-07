import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { openDatabase } from './client.js'

interface Journal {
  entries: { idx: number; tag: string }[]
}

describe('repo releases migration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('adds the release columns to a populated database with safe defaults', () => {
    const { migrationsDir } = loadConfig({})
    const dir = mkdtempSync(join(tmpdir(), 'hinomi-mig-'))
    dirs.push(dir)
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
    ) as Journal
    const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_repo_releases'))
    if (upTo < 1) throw new Error('no repo_releases migration')
    const entries = journal.entries.slice(0, upTo)
    const old = join(dir, 'old')
    mkdirSync(join(old, 'meta'), { recursive: true })
    for (const entry of entries) {
      cpSync(join(migrationsDir, `${entry.tag}.sql`), join(old, `${entry.tag}.sql`))
    }
    writeFileSync(join(old, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))

    const file = join(dir, 'hinomi.db')
    const before = openDatabase({ file, migrationsDir: old })
    before.sqlite
      .prepare("insert into repos (owner, name) values ('kestrel-co', 'kestrel-desk')")
      .run()
    before.sqlite
      .prepare(
        "insert into findings (dedupe_key, kind, repo_id, first_seen_at, last_seen_at) values ('blind:alerts_disabled:repo:1', 'blind_spot', 1, 0, 0)",
      )
      .run()
    before.close()

    const after = openDatabase({ file, migrationsDir })
    expect(
      after.sqlite
        .prepare(
          'select release_tier, latest_release_tag, latest_release_at, release_installers, release_checked_at from repos',
        )
        .get(),
    ).toEqual({
      release_tier: 'auto',
      latest_release_tag: null,
      latest_release_at: null,
      release_installers: null,
      release_checked_at: null,
    })
    expect(after.sqlite.prepare('select fixed_on_default_branch from findings').pluck().get()).toBe(
      0,
    )
    after.close()
  })
})
