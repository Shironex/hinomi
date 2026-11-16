import { describe, expect, it } from 'vitest'
import { createTestRepositories } from '../db/test-db.js'
import { consumeSetupCode, issueSetupCode, SETUP_CODE_KEY } from './setup-code.js'

describe('setup codes', () => {
  const at = new Date('2026-11-05T10:00:00Z')

  it('are 12 unambiguous characters in groups of four, stored only as a hash', () => {
    const { repos } = createTestRepositories()
    const { code, expiresAt } = issueSetupCode(repos.settings, at)
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    expect(expiresAt.toISOString()).toBe('2026-11-05T10:15:00.000Z')
    expect(JSON.stringify(repos.settings.all())).not.toContain(code.replaceAll('-', ''))
  })

  it('replace the previous code', () => {
    const { repos } = createTestRepositories()
    const first = issueSetupCode(repos.settings, at).code
    const second = issueSetupCode(repos.settings, at).code
    expect(consumeSetupCode(repos.settings, first, at)).toBe(false)
    expect(consumeSetupCode(repos.settings, second, at)).toBe(true)
  })

  it('are spent on use and removed when expired', () => {
    const { repos } = createTestRepositories()
    const { code } = issueSetupCode(repos.settings, at)
    expect(consumeSetupCode(repos.settings, code, at)).toBe(true)
    expect(consumeSetupCode(repos.settings, code, at)).toBe(false)
    const late = issueSetupCode(repos.settings, at).code
    expect(consumeSetupCode(repos.settings, late, new Date(at.getTime() + 15 * 60 * 1000))).toBe(
      false,
    )
    expect(repos.settings.all()[SETUP_CODE_KEY]).toBeUndefined()
  })
})
