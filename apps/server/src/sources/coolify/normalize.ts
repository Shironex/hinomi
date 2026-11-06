/**
 * Reduce a Coolify git repository value to `owner/name`.
 * Handles https, ssh:// and scp style (git@host:owner/name.git) URLs, host/owner/name
 * without a scheme, and the bare `owner/name` that GitHub App sources store.
 * Returns null when nothing usable is left.
 */
export function normalizeRepo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  let path: string
  const scp = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(value)
  if (scp?.[1]) {
    path = scp[1]
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname
    } catch {
      return null
    }
  } else {
    const parts = value.split('/').filter(Boolean)
    // A leading segment with a dot is a host (github.com/owner/name), not an owner.
    path = (parts[0]?.includes('.') ? parts.slice(1) : parts).join('/')
  }

  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const owner = segments[0] as string
  const name = (segments[1] as string).replace(/\.git$/i, '')
  if (!owner || !name) return null
  return `${owner}/${name}`
}

/** Split a comma (or whitespace) separated fqdn field into trimmed, unique domains. */
export function parseDomains(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const seen = new Set<string>()
  for (const part of raw.split(/[,\s]+/)) {
    const domain = part.trim().replace(/\/+$/, '')
    if (domain) seen.add(domain)
  }
  return [...seen]
}

export function hasPublicDomain(domains: readonly string[]): boolean {
  return domains.some((d) => /^https?:\/\/[^/\s]+/i.test(d))
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Valid ISO timestamp or null. */
export function toIso(value: unknown): string | null {
  const s = str(value)
  if (!s) return null
  const time = Date.parse(s)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** Join image name and tag the way docker does. */
export function joinImage(name: unknown, tag: unknown): string | null {
  const n = str(name)
  if (!n) return null
  const t = str(tag)
  return t && !n.includes(':') && !n.includes('@') ? `${n}:${t}` : n
}

/** Coolify stores watch paths as a newline (or comma) separated string. */
export function parseWatchPaths(raw: unknown): string[] | null {
  if (Array.isArray(raw))
    return raw.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  if (typeof raw !== 'string') return null
  return raw
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}
