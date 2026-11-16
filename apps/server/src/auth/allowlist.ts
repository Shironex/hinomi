/**
 * HINOMI_AUTH_ALLOWED: who may sign in through OpenID Connect or GitHub. Comma separated:
 *
 * - `alice@example.dev`: that verified email,
 * - `@example.dev`: any verified email at that domain (not its subdomains),
 * - `github:octocat`: that GitHub login (GitHub sign in only),
 * - `oidc:<sub>`: that OpenID Connect subject, for providers without a verified email.
 *
 * Passkeys are not checked against it: registering one already needs a session or a setup code.
 */

export type AllowRule =
  | { kind: 'email'; email: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'github'; login: string }
  | { kind: 'oidc'; sub: string }

export class InvalidAllowRuleError extends Error {
  constructor(entry: string) {
    super(`"${entry}" is not an email, an @domain, github:<login> or oidc:<subject>`)
    this.name = 'InvalidAllowRuleError'
  }
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
const DOMAIN = /^@[a-z0-9.-]+\.[a-z]{2,}$/
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/

/** Parses the comma separated list. @throws InvalidAllowRuleError on the first bad entry. */
export function parseAllowRules(value: string | undefined): AllowRule[] {
  const rules: AllowRule[] = []
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (entry === '') continue
    const lower = entry.toLowerCase()
    if (lower.startsWith('github:')) {
      const login = lower.slice('github:'.length)
      if (!GITHUB_LOGIN.test(login)) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'github', login })
    } else if (lower.startsWith('oidc:')) {
      // Subjects are case sensitive and opaque.
      const sub = entry.slice('oidc:'.length)
      if (sub === '' || sub.length > 255) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'oidc', sub })
    } else if (DOMAIN.test(lower)) {
      rules.push({ kind: 'domain', domain: lower.slice(1) })
    } else if (EMAIL.test(lower)) {
      rules.push({ kind: 'email', email: lower })
    } else {
      throw new InvalidAllowRuleError(entry)
    }
  }
  return rules
}

/** What a provider proved about the person. Emails only when the provider says they are verified. */
export interface ProvenIdentity {
  provider: 'oidc' | 'github'
  /** OIDC `sub`, or the GitHub login. */
  id: string
  verifiedEmails: string[]
}

/**
 * The session subject when a rule admits the identity: the matching verified email, or
 * `github:<login>` / `oidc:<sub>`. Null when no rule does.
 */
export function admit(rules: readonly AllowRule[], identity: ProvenIdentity): string | null {
  // The provider's own id first: it names the account, an email only one of its addresses.
  for (const rule of rules) {
    if (rule.kind === 'github' && identity.provider === 'github') {
      if (identity.id.toLowerCase() === rule.login) return `github:${rule.login}`
    } else if (rule.kind === 'oidc' && identity.provider === 'oidc') {
      if (identity.id === rule.sub) return `oidc:${rule.sub}`
    }
  }
  const emails = identity.verifiedEmails.map((email) => email.trim().toLowerCase())
  for (const rule of rules) {
    if (rule.kind === 'email') {
      if (emails.includes(rule.email)) return rule.email
    } else if (rule.kind === 'domain') {
      const match = emails.find((email) => email.split('@')[1] === rule.domain)
      if (match) return match
    }
  }
  return null
}

/** Whether a stored session subject is still admitted, for the boot time check of old sessions. */
export function stillAdmitted(rules: readonly AllowRule[], subject: string): boolean {
  if (subject.startsWith('github:')) {
    return admit(rules, { provider: 'github', id: subject.slice(7), verifiedEmails: [] }) !== null
  }
  if (subject.startsWith('oidc:')) {
    return admit(rules, { provider: 'oidc', id: subject.slice(5), verifiedEmails: [] }) !== null
  }
  return admit(rules, { provider: 'oidc', id: '', verifiedEmails: [subject] }) !== null
}
