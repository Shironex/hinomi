// Just enough semver for the runner: exact versions (the dispatch only carries exact ones),
// compared with prerelease precedence. Ranges are never evaluated here.

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const EXACT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses an exact version such as `1.2.3` or `1.2.3-rc.1+build`, null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = EXACT.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Negative when a < b, positive when a > b, 0 when equal. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch
  if (core !== 0) return core
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const diff = compareIdentifiers(x, y)
    if (diff !== 0) return diff
  }
  return 0
}

/** True when `version` is at least `minimum`. */
export function atLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0
}
