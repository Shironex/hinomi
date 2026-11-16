import { describe, expect, it } from 'vitest'
import { admit, InvalidAllowRuleError, parseAllowRules, stillAdmitted } from './allowlist.js'

describe('parseAllowRules', () => {
  it('reads emails, domains, GitHub logins and OIDC subjects', () => {
    expect(
      parseAllowRules(' Ops@Example.dev, @kestrel.example.dev ,github:Kestrel-Ops, oidc:AbC-123 ,'),
    ).toEqual([
      { kind: 'email', email: 'ops@example.dev' },
      { kind: 'domain', domain: 'kestrel.example.dev' },
      { kind: 'github', login: 'kestrel-ops' },
      { kind: 'oidc', sub: 'AbC-123' },
    ])
    expect(parseAllowRules(undefined)).toEqual([])
  })

  it.each(['ops', '@', 'github:', 'github:bad login', 'oidc:', '*'])('refuses %s', (entry) => {
    expect(() => parseAllowRules(entry)).toThrow(InvalidAllowRuleError)
  })
})

describe('admit', () => {
  const rules = parseAllowRules(
    'ops@example.dev, @kestrel.example.dev, github:kestrel-ops, oidc:user-7f3a',
  )

  it('admits a verified email, case insensitively', () => {
    expect(admit(rules, { provider: 'oidc', id: 'x', verifiedEmails: ['OPS@example.dev'] })).toBe(
      'ops@example.dev',
    )
  })

  it('admits a domain but not its subdomains or look alikes', () => {
    expect(
      admit(rules, { provider: 'oidc', id: 'x', verifiedEmails: ['dev@kestrel.example.dev'] }),
    ).toBe('dev@kestrel.example.dev')
    expect(
      admit(rules, { provider: 'oidc', id: 'x', verifiedEmails: ['dev@sub.kestrel.example.dev'] }),
    ).toBeNull()
    expect(
      admit(rules, { provider: 'oidc', id: 'x', verifiedEmails: ['dev@evilkestrel.example.dev'] }),
    ).toBeNull()
  })

  it('keeps provider ids to their provider', () => {
    expect(admit(rules, { provider: 'github', id: 'Kestrel-Ops', verifiedEmails: [] })).toBe(
      'github:kestrel-ops',
    )
    expect(admit(rules, { provider: 'oidc', id: 'kestrel-ops', verifiedEmails: [] })).toBeNull()
    expect(admit(rules, { provider: 'oidc', id: 'user-7f3a', verifiedEmails: [] })).toBe(
      'oidc:user-7f3a',
    )
    expect(admit(rules, { provider: 'github', id: 'user-7f3a', verifiedEmails: [] })).toBeNull()
  })

  it('prefers the provider id over an email', () => {
    expect(
      admit(rules, { provider: 'github', id: 'kestrel-ops', verifiedEmails: ['ops@example.dev'] }),
    ).toBe('github:kestrel-ops')
  })

  it('admits nothing without a matching rule', () => {
    expect(
      admit(rules, { provider: 'github', id: 'someone', verifiedEmails: ['x@example.dev'] }),
    ).toBeNull()
    expect(admit([], { provider: 'oidc', id: 'x', verifiedEmails: ['ops@example.dev'] })).toBeNull()
  })
})

describe('stillAdmitted', () => {
  it('rechecks stored subjects against new rules', () => {
    const rules = parseAllowRules('ops@example.dev, github:kestrel-ops')
    expect(stillAdmitted(rules, 'ops@example.dev')).toBe(true)
    expect(stillAdmitted(rules, 'github:kestrel-ops')).toBe(true)
    expect(stillAdmitted(rules, 'github:someone')).toBe(false)
    expect(stillAdmitted(rules, 'oidc:user-7f3a')).toBe(false)
    expect(stillAdmitted(rules, 'old@example.dev')).toBe(false)
  })
})
