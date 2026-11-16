import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestRepositories } from '../db/test-db.js'
import type { DatabaseHandle } from '../db/client.js'
import { AUDIT_KEEP_FAILED_LOGINS } from './audit.js'
import type { Repositories } from './index.js'

let repos: Repositories
let handle: DatabaseHandle

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
})
afterEach(() => handle.close())

describe('audit log', () => {
  it('keeps a flood of refused logins from pushing out other events', () => {
    repos.audit.record({ action: 'login', actor: 'admin', detail: 'passkey' })
    repos.audit.record({ action: 'change', method: 'PATCH', path: '/api/settings' })
    for (let i = 0; i < AUDIT_KEEP_FAILED_LOGINS + 300; i++) {
      repos.audit.record({ action: 'login_failed', detail: 'setup code: wrong or expired' })
    }
    const rows = repos.audit.list({ limit: 10_000 })
    expect(rows.filter((r) => r.action === 'login').length).toBe(1)
    expect(rows.filter((r) => r.action === 'change').length).toBe(1)
    const failed = rows.filter((r) => r.action === 'login_failed').length
    expect(failed).toBeGreaterThanOrEqual(AUDIT_KEEP_FAILED_LOGINS)
    expect(failed).toBeLessThan(AUDIT_KEEP_FAILED_LOGINS + 100)
  })
})
