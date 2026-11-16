/**
 * HINOMI_AUTH_ALLOWED: who may sign in through OpenID Connect or GitHub. Comma separated:
 *
 * - `alice@example.dev`: that verified email,
 * - `@example.dev`: any verified email at that domain (not its subdomains),
 * - `github:id:583231`: that GitHub account, by its numeric id (GitHub sign in only),
 * - `github:octocat`: that GitHub login, pinned to the account id that first signs in with it,
 * - `oidc:<sub>`: that OpenID Connect subject, for providers without a verified email.
 *
 * Emails are matched in a strict ASCII addr-spec form only: one `@`, a dot-atom local part, a
 * host name domain, ASCII lowercased. Anything else (a quoted local part, a second `@`, Unicode
 * that folds into ASCII like the KELVIN SIGN) never matches a rule.
 *
 * Passkeys registered through a provider are checked against it too, by the subject that
 * registered them (auth/service.ts); passkeys registered with a setup code are not.
 */

export type AllowRule =
  | { kind: 'email'; email: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'githubId'; id: string }
  | { kind: 'github'; login: string }
  | { kind: 'oidc'; sub: string }

export class InvalidAllowRuleError extends Error {
  constructor(entry: string) {
    super(
      `"${entry}" is not an email, an @domain, github:id:<number>, github:<login> or oidc:<subject>`,
    )
    this.name = 'InvalidAllowRuleError'
  }
}

const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const LOCAL_PART = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`)
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`)
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const GITHUB_ID = /^[1-9][0-9]{0,19}$/

/** ASCII only lowercasing: no Unicode case folding, so no character can fold into a match. */
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase())

/**
 * The canonical form of an email, or null when it is not a plain ASCII addr-spec: exactly one
 * `@`, a dot-atom local part (no quotes, no comments), and a host name with at least one dot.
 */
export function normalizeEmail(value: string): string | null {
  const text = value.trim()
  if (text.length > 254 || !PRINTABLE_ASCII.test(text)) return null
  const at = text.lastIndexOf('@')
  if (at <= 0 || text.indexOf('@') !== at) return null
  const local = text.slice(0, at)
  const domain = asciiLower(text.slice(at + 1))
  if (local.length > 64 || !LOCAL_PART.test(local) || !HOST.test(domain)) return null
  return `${asciiLower(local)}@${domain}`
}

/** Parses the comma separated list. @throws InvalidAllowRuleError on the first bad entry. */
export function parseAllowRules(value: string | undefined): AllowRule[] {
  const rules: AllowRule[] = []
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (entry === '') continue
    if (!PRINTABLE_ASCII.test(entry)) throw new InvalidAllowRuleError(entry)
    const lower = asciiLower(entry)
    if (lower.startsWith('github:id:')) {
      const id = lower.slice('github:id:'.length)
      if (!GITHUB_ID.test(id)) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'githubId', id })
    } else if (lower.startsWith('github:')) {
      const login = lower.slice('github:'.length)
      if (!GITHUB_LOGIN.test(login)) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'github', login })
    } else if (lower.startsWith('oidc:')) {
      // Subjects are case sensitive and opaque.
      const sub = entry.slice('oidc:'.length)
      if (sub === '' || sub.length > 255) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'oidc', sub })
    } else if (lower.startsWith('@')) {
      const domain = lower.slice(1)
      if (!HOST.test(domain)) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'domain', domain })
    } else {
      const email = normalizeEmail(entry)
      if (!email) throw new InvalidAllowRuleError(entry)
      rules.push({ kind: 'email', email })
    }
  }
  return rules
}

/** What a provider proved about the person. Emails only when the provider says they are verified. */
export type ProvenIdentity =
  | { provider: 'oidc'; id: string; verifiedEmails: string[] }
  | {
      provider: 'github'
      /** The numeric account id, as a string: it never changes, unlike the login. */
      id: string
      login: string
      verifiedEmails: string[]
    }

/** `github:<login>` rules pinned to the account id that first signed in with them, by login. */
export type GithubPins = ReadonlyMap<string, string>

export type Admission =
  | {
      ok: true
      /** The session subject: the matching verified email, `github:id:<n>` or `oidc:<sub>`. */
      subject: string
      /** A `github:<login>` rule seen for the first time: pin it to this id. */
      pin: { login: string; id: string } | null
    }
  | {
      ok: false
      /** `github_id_changed`: a pinned login now belongs to another GitHub account. */
      reason: 'not_allowed' | 'github_id_changed'
    }

/** Whether a rule admits the identity, and as which subject. */
export function admit(
  rules: readonly AllowRule[],
  identity: ProvenIdentity,
  pins: GithubPins = new Map(),
): Admission {
  let idChanged = false
  // The provider's own id first: it names the account, an email only one of its addresses.
  for (const rule of rules) {
    if (identity.provider === 'github') {
      if (rule.kind === 'githubId' && rule.id === identity.id) {
        return { ok: true, subject: `github:id:${identity.id}`, pin: null }
      }
      if (rule.kind === 'github' && asciiLower(identity.login) === rule.login) {
        const pinned = pins.get(rule.login)
        if (pinned === undefined) {
          return {
            ok: true,
            subject: `github:id:${identity.id}`,
            pin: { login: rule.login, id: identity.id },
          }
        }
        if (pinned === identity.id) {
          return { ok: true, subject: `github:id:${identity.id}`, pin: null }
        }
        idChanged = true
      }
    } else if (rule.kind === 'oidc' && rule.sub === identity.id) {
      return { ok: true, subject: `oidc:${identity.id}`, pin: null }
    }
  }
  const emails = identity.verifiedEmails
    .map(normalizeEmail)
    .filter((email): email is string => email !== null)
  for (const rule of rules) {
    if (rule.kind === 'email') {
      if (emails.includes(rule.email)) return { ok: true, subject: rule.email, pin: null }
    } else if (rule.kind === 'domain') {
      const match = emails.find((email) => email.slice(email.lastIndexOf('@') + 1) === rule.domain)
      if (match) return { ok: true, subject: match, pin: null }
    }
  }
  return { ok: false, reason: idChanged ? 'github_id_changed' : 'not_allowed' }
}

/**
 * Whether a stored subject (of a session, or the owner of a passkey) is still admitted by the
 * rules, for the checks at boot and at passkey login. Unknown forms are not.
 */
export function stillAdmitted(
  rules: readonly AllowRule[],
  subject: string,
  pins: GithubPins = new Map(),
): boolean {
  const github = /^github:id:([1-9][0-9]*)$/.exec(subject)
  if (github) {
    const id = github[1] as string
    return rules.some(
      (rule) =>
        (rule.kind === 'githubId' && rule.id === id) ||
        (rule.kind === 'github' && pins.get(rule.login) === id),
    )
  }
  if (subject.startsWith('github:')) return false
  if (subject.startsWith('oidc:')) {
    const sub = subject.slice('oidc:'.length)
    return rules.some((rule) => rule.kind === 'oidc' && rule.sub === sub)
  }
  const email = normalizeEmail(subject)
  if (!email) return false
  return admit(rules, { provider: 'oidc', id: '', verifiedEmails: [email] }).ok
}
