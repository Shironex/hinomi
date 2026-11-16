import { describe, expect, it } from 'vitest'
import {
  admit,
  InvalidAllowRuleError,
  normalizeEmail,
  parseAllowRules,
  stillAdmitted,
  type ProvenIdentity,
} from './allowlist.js'

const oidc = (verifiedEmails: string[], id = 'x'): ProvenIdentity => ({
  provider: 'oidc',
  id,
  verifiedEmails,
})
const github = (login: string, id: string, verifiedEmails: string[] = []): ProvenIdentity => ({
  provider: 'github',
  id,
  login,
  verifiedEmails,
})

describe('normalizeEmail', () => {
  it('keeps a plain addr-spec, lowercased in ASCII', () => {
    expect(normalizeEmail(' Ops.Team+hinomi@Example.DEV ')).toBe('ops.team+hinomi@example.dev')
  })

  it.each([
    ['a second @', '"x@example.dev@"@evil.com'],
    ['two @ unquoted', 'x@example.dev@evil.com'],
    ['a quoted local part', '"ops"@example.dev'],
    ['a comment', 'ops(comment)@example.dev'],
    ['a space', 'ops @example.dev'],
    ['no domain dot', 'ops@localhost'],
    ['an empty local part', '@example.dev'],
    ['a leading dot', '.ops@example.dev'],
    ['two dots', 'ops..team@example.dev'],
    ['the KELVIN SIGN', 'ops@Kestrel.example.dev'],
    ['a dotless i that uppercases to I', 'admın@example.dev'],
    ['full width letters', 'ops@ｅxample.dev'],
    ['a domain label ending in a dash', 'ops@example-.dev'],
  ])('refuses %s', (_why, value) => {
    expect(normalizeEmail(value)).toBeNull()
  })
})

describe('parseAllowRules', () => {
  it('reads emails, domains, GitHub ids and logins, and OIDC subjects', () => {
    expect(
      parseAllowRules(
        ' Ops@Example.dev, @kestrel.example.dev ,github:id:583231, github:Kestrel-Ops, oidc:AbC-123 ,',
      ),
    ).toEqual([
      { kind: 'email', email: 'ops@example.dev' },
      { kind: 'domain', domain: 'kestrel.example.dev' },
      { kind: 'githubId', id: '583231' },
      { kind: 'github', login: 'kestrel-ops' },
      { kind: 'oidc', sub: 'AbC-123' },
    ])
    expect(parseAllowRules(undefined)).toEqual([])
  })

  it.each([
    'ops',
    '@',
    'github:',
    'github:bad login',
    'github:id:',
    'github:id:0',
    'github:id:12a',
    'oidc:',
    '*',
    '"x@example.dev@"@evil.com',
    '@Kestrel.example.dev',
    'ops@Kestrel.example.dev',
  ])('refuses %s', (entry) => {
    expect(() => parseAllowRules(entry)).toThrow(InvalidAllowRuleError)
  })
})

describe('admit', () => {
  const rules = parseAllowRules(
    'ops@example.dev, @kestrel.example.dev, github:id:583231, github:kestrel-ops, oidc:user-7f3a',
  )

  it('admits a verified email, ASCII case insensitively', () => {
    expect(admit(rules, oidc(['OPS@example.dev']))).toEqual({
      ok: true,
      subject: 'ops@example.dev',
      pin: null,
    })
  })

  it('admits a domain but not its subdomains or look alikes', () => {
    expect(admit(rules, oidc(['dev@kestrel.example.dev']))).toMatchObject({
      ok: true,
      subject: 'dev@kestrel.example.dev',
    })
    expect(admit(rules, oidc(['dev@sub.kestrel.example.dev'])).ok).toBe(false)
    expect(admit(rules, oidc(['dev@evilkestrel.example.dev'])).ok).toBe(false)
  })

  it('never takes the domain after the first @', () => {
    // The probe from review: a quoted local part that ends in the allowed domain.
    expect(admit(rules, oidc(['"x@kestrel.example.dev@"@evil.com']))).toEqual({
      ok: false,
      reason: 'not_allowed',
    })
    expect(admit(rules, oidc(['x@kestrel.example.dev@evil.com'])).ok).toBe(false)
  })

  it('does not fold Unicode into an allowed address (KELVIN SIGN)', () => {
    // U+212A lowercases to "k" in JavaScript: a naive toLowerCase would admit it.
    expect('K'.toLowerCase()).toBe('k')
    expect(admit(rules, oidc(['dev@Kestrel.example.dev'])).ok).toBe(false)
    expect(admit(rules, oidc(['OPS@EXAMPLE.DEV'])).ok).toBe(true)
  })

  it('matches GitHub on the numeric id, not the login', () => {
    expect(admit(rules, github('renamed-later', '583231'))).toEqual({
      ok: true,
      subject: 'github:id:583231',
      pin: null,
    })
    expect(admit(rules, github('someone', '999'))).toEqual({ ok: false, reason: 'not_allowed' })
  })

  it('pins a github:<login> rule to the first account id', () => {
    const first = admit(rules, github('Kestrel-Ops', '42'))
    expect(first).toEqual({
      ok: true,
      subject: 'github:id:42',
      pin: { login: 'kestrel-ops', id: '42' },
    })
    const pins = new Map([['kestrel-ops', '42']])
    expect(admit(rules, github('kestrel-ops', '42'), pins)).toEqual({
      ok: true,
      subject: 'github:id:42',
      pin: null,
    })
  })

  it('refuses a renamed and reclaimed login with another id', () => {
    const pins = new Map([['kestrel-ops', '42']])
    expect(admit(rules, github('kestrel-ops', '7777'), pins)).toEqual({
      ok: false,
      reason: 'github_id_changed',
    })
    // The new owner's own allowed email still counts on its own merit.
    expect(admit(rules, github('kestrel-ops', '7777', ['ops@example.dev']), pins)).toMatchObject({
      ok: true,
      subject: 'ops@example.dev',
    })
  })

  it('keeps provider ids to their provider', () => {
    expect(admit(rules, oidc([], 'kestrel-ops')).ok).toBe(false)
    expect(admit(rules, oidc([], 'user-7f3a'))).toMatchObject({ subject: 'oidc:user-7f3a' })
    expect(admit(rules, github('user-7f3a', '5')).ok).toBe(false)
  })

  it('prefers the provider id over an email', () => {
    expect(admit(rules, github('x', '583231', ['ops@example.dev']))).toMatchObject({
      subject: 'github:id:583231',
    })
  })

  it('admits nothing without a matching rule', () => {
    expect(admit(rules, github('someone', '5', ['x@example.dev'])).ok).toBe(false)
    expect(admit([], oidc(['ops@example.dev'])).ok).toBe(false)
  })
})

describe('stillAdmitted', () => {
  it('rechecks stored subjects against new rules', () => {
    const rules = parseAllowRules('ops@example.dev, github:id:583231, github:kestrel-ops')
    const pins = new Map([['kestrel-ops', '42']])
    expect(stillAdmitted(rules, 'ops@example.dev', pins)).toBe(true)
    expect(stillAdmitted(rules, 'github:id:583231', pins)).toBe(true)
    expect(stillAdmitted(rules, 'github:id:42', pins)).toBe(true)
    expect(stillAdmitted(rules, 'github:id:42')).toBe(false)
    expect(stillAdmitted(rules, 'github:id:7777', pins)).toBe(false)
    // The old login form is not trusted any more.
    expect(stillAdmitted(rules, 'github:kestrel-ops', pins)).toBe(false)
    expect(stillAdmitted(rules, 'oidc:user-7f3a', pins)).toBe(false)
    expect(stillAdmitted(rules, 'old@example.dev', pins)).toBe(false)
    expect(stillAdmitted(rules, 'admin', pins)).toBe(false)
  })
})
