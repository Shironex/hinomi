import type { OsvEvent, OsvRange } from '@hinomi/shared'

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split('.') : [],
  }
}

function comparePre(a: string[], b: string[]): number {
  // A release sorts after any of its prereleases.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** True when `compareVersions` can order the version by semver rather than by string. */
export function isComparableVersion(version: string): boolean {
  return parse(version) !== null
}

/** Semver precedence compare. Unparseable versions sort by plain string order. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!
    if (d !== 0) return Math.sign(d)
  }
  return comparePre(pa.pre, pb.pre)
}

/** `introduced: "0"` means "from the very first version". */
const eventVersion = (e: OsvEvent): string =>
  e.introduced ?? e.fixed ?? e.last_affected ?? e.limit ?? '0'

export interface RangeHit {
  /** Lower bound of the interval holding the version, null for "from the start". */
  introduced: string | null
  fixed: string | null
  lastAffected: string | null
}

/**
 * Evaluates one OSV SEMVER or ECOSYSTEM range. Returns the interval holding
 * `version`, or null when the version is not affected by this range.
 */
export function matchRange(range: OsvRange, version: string): RangeHit | null {
  if (range.type === 'GIT') return null
  const events = [...range.events].sort((a, b) => {
    const va = eventVersion(a)
    const vb = eventVersion(b)
    if (va === '0' && vb !== '0') return -1
    if (vb === '0' && va !== '0') return 1
    return compareVersions(va, vb)
  })
  let hit: RangeHit | null = null
  for (const event of events) {
    if (event.introduced !== undefined) {
      if (event.introduced === '0' || compareVersions(version, event.introduced) >= 0) {
        hit = {
          introduced: event.introduced === '0' ? null : event.introduced,
          fixed: null,
          lastAffected: null,
        }
      }
    } else if (event.fixed !== undefined && hit) {
      if (compareVersions(version, event.fixed) >= 0) hit = null
      else if (!hit.fixed && !hit.lastAffected) hit.fixed = event.fixed
    } else if (event.last_affected !== undefined && hit) {
      if (compareVersions(version, event.last_affected) > 0) hit = null
      else if (!hit.fixed && !hit.lastAffected) hit.lastAffected = event.last_affected
    } else if (event.limit !== undefined && hit && event.limit !== '*') {
      if (compareVersions(version, event.limit) >= 0) hit = null
    }
  }
  return hit
}

/** GitHub style range text, e.g. `>= 1.0.0, < 1.2.3`. */
export function formatRange(hit: RangeHit): string {
  const parts: string[] = []
  if (hit.introduced) parts.push(`>= ${hit.introduced}`)
  if (hit.fixed) parts.push(`< ${hit.fixed}`)
  else if (hit.lastAffected) parts.push(`<= ${hit.lastAffected}`)
  return parts.length > 0 ? parts.join(', ') : '>= 0'
}
