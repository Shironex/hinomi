import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { SECRET_MARKER, dokployRoutes, fakeDokployFetch } from '../sources/dokploy/testing.js'
import { runScan, type ScanLogger } from './run.js'
import { buildScanSources } from './sources.js'

// A whole scan over a fictional Dokploy instance whose answers are full of secret looking
// values (database passwords, environment variables, registry and webhook secrets). None of
// them may reach the database or a log line.

const AT = new Date('2026-11-15T06:00:00Z')
const KEY = 'fictional-dokploy-key-01'

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  ;({ repos, handle } = createTestRepositories())
})
afterEach(() => {
  handle.close()
  vi.restoreAllMocks()
})

/** Every row of every table, as text. */
function dumpDatabase(): string {
  const tables = handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]
  return tables
    .map(({ name }) => JSON.stringify(handle.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n')
}

function capturingLogger(lines: string[]): ScanLogger {
  const push = (message: string, data?: Record<string, unknown>) =>
    lines.push(`${message} ${JSON.stringify(data ?? {})}`)
  return { info: push, warn: push, error: push }
}

async function scanWith(routes: Record<string, string | Response>) {
  const source = repos.sources.create({
    kind: 'dokploy',
    name: 'apps',
    baseUrl: 'https://dokploy.example.dev',
    token: KEY,
  })
  const { impl } = fakeDokployFetch(routes)
  const lines: string[] = []
  const consoleLines: string[] = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '))
    })
  }
  const summary = await runScan({ repositories: repos }, buildScanSources(repos, { fetch: impl }), {
    now: () => AT,
    guards: [],
    log: capturingLogger(lines),
  })
  return { source, summary, logs: [...lines, ...consoleLines].join('\n') }
}

describe('a scan over a Dokploy source', () => {
  it('stores its deployments without any secret value, and logs none', async () => {
    const { source, summary, logs } = await scanWith(dokployRoutes())
    expect(summary.sourceResults.dokploy?.status).toBe('ok')
    const stored = repos.deployments.listBySource(source.id)
    expect(stored.map((d) => d.externalId).sort()).toEqual([
      'app-harbor-0001',
      'app-lantern-0003',
      'app-proxy-0002',
      'cmp-docs-0001',
    ])
    const db = dumpDatabase()
    expect(db).not.toContain(SECRET_MARKER)
    // The key itself is only stored encrypted.
    expect(db).not.toContain(KEY)
    expect(logs).not.toContain(SECRET_MARKER)
    expect(logs).not.toContain(KEY)
  })

  it('records a failed read without any secret value or the key', async () => {
    const { source, summary, logs } = await scanWith({
      ...dokployRoutes(),
      'application.one?applicationId=app-harbor-0001': new Response(
        `{"error": "${SECRET_MARKER}-echoed ${KEY}"}`,
        { status: 500 },
      ),
    })
    expect(summary.sourceResults.dokploy?.status).toBe('error')
    expect(repos.sources.get(source.id)?.lastError).toContain('application.one')
    const db = dumpDatabase()
    expect(db).not.toContain(SECRET_MARKER)
    expect(db).not.toContain(KEY)
    expect(logs).not.toContain(SECRET_MARKER)
    expect(logs).not.toContain(KEY)
  })
})
