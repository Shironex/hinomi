import { describe, expect, it } from 'vitest'
import { createTestRepositories } from '../db/test-db.js'
import { admit, parseAllowRules } from './allowlist.js'
import { pinGithubLogin, readGithubPins } from './github-pins.js'

describe('GitHub login pins', () => {
  it('keeps the first pin of a login', () => {
    const { repos } = createTestRepositories()
    pinGithubLogin(repos.settings, 'kestrel-ops', '583231')
    pinGithubLogin(repos.settings, 'kestrel-ops', '999')
    expect(readGithubPins(repos.settings).get('kestrel-ops')).toBe('583231')
  })

  // Logins that are also members of Object.prototype must pin like any other.
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'pins the login %s on first admission and refuses another id for it',
    (login) => {
      const { repos } = createTestRepositories()
      const rules = parseAllowRules(`github:${login}`)
      const identity = { provider: 'github' as const, login, verifiedEmails: [] }
      const first = admit(rules, { ...identity, id: '583231' }, readGithubPins(repos.settings))
      expect(first).toMatchObject({ ok: true, pin: { id: '583231' } })
      if (!first.ok || !first.pin) throw new Error('expected a pin')
      pinGithubLogin(repos.settings, first.pin.login, first.pin.id)
      const pins = readGithubPins(repos.settings)
      expect(pins.get(login.toLowerCase())).toBe('583231')
      expect(admit(rules, { ...identity, id: '583231' }, pins)).toMatchObject({
        ok: true,
        pin: null,
      })
      expect(admit(rules, { ...identity, id: '777' }, pins)).toEqual({
        ok: false,
        reason: 'github_id_changed',
      })
    },
  )
})
