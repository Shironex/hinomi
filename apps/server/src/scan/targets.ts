import type { BumpLevel, FixPlanTargetCheck, OsvEcosystem, OsvVulnerability } from '@hinomi/shared'
import type { AdvisoryRow } from '../db/schema.js'
import {
  compareVersions,
  formatRange,
  rangeIntervals,
  type OsvClient,
} from '../sources/osv/index.js'
import { errorMessage } from './collect.js'

// Picks the version a fix plan step upgrades to: the lowest version that clears the step's
// findings and has no known advisory of its own. Known means stored by Hinomi (GitHub and OSV
// findings of any repo) or reported by OSV for that exact version during this scan. The server
// has no registry access, so candidates are versions advisories name as fixes: first patched
// versions and the upper bounds of vulnerable ranges.

/** An advisory of one package, reduced to what the target check needs. */
export interface KnownAdvisory {
  /** The key shown in the plan: the GHSA id when there is one. */
  key: string
  /** Every id it is known by, to merge stored and OSV copies of the same advisory. */
  ids: string[]
  /** GitHub style ranges, e.g. `>= 1.0.0, < 1.2.3`; `= 1.2.3` for a listed version. */
  ranges: string[]
  /** Versions that leave a range: candidates for a clean target. */
  fixed: string[]
}

/** What OSV said about one version: its advisories, or `unavailable` when it could not answer. */
export type OsvAnswer = readonly KnownAdvisory[] | 'unavailable'

/** Everything the target check reads. Plain data, so the plan builder stays pure. */
export interface TargetFacts {
  /** Advisories Hinomi stores for a package. */
  stored: (ecosystem: string, packageName: string) => readonly KnownAdvisory[]
  /** OSV answers per packageKey, then per version. Null when OSV is off. */
  osv: ReadonlyMap<string, ReadonlyMap<string, OsvAnswer>> | null
}

/** A version the check wants OSV to answer for before it can decide. */
export interface TargetQuery {
  ecosystem: string
  packageName: string
  version: string
}

export type TargetChoice =
  /** The check does not apply: an ecosystem OSV is not asked about, or a version not semver. */
  | { kind: 'skip' }
  | { kind: 'pending'; query: TargetQuery }
  | { kind: 'done'; to: string; check: FixPlanTargetCheck; note: string | null }

export const packageKey = (ecosystem: string, packageName: string) =>
  `${ecosystem}\u0000${packageName}`

/** OSV's name for a stored ecosystem; null for ecosystems a plan does not apply. */
export function osvEcosystemOf(ecosystem: string): OsvEcosystem | null {
  if (ecosystem === 'npm') return 'npm'
  if (ecosystem === 'rust' || ecosystem === 'crates.io') return 'crates.io'
  return null
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const isPrerelease = (version: string) => version.includes('-')

function semverParts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/**
 * Semver distance from `from` to `to`. A change of the first non zero part is major, as caret
 * ranges in npm and Cargo treat it, so 0.3 to 0.4 is major.
 */
export function bumpLevel(from: string, to: string): BumpLevel {
  const a = semverParts(from)
  const b = semverParts(to)
  if (!a || !b) return 'unknown'
  if (a[0] !== b[0]) return 'major'
  if (a[0] === 0 && a[1] !== b[1]) return 'major'
  if (a[1] !== b[1]) return 'minor'
  return 'patch'
}

const CONSTRAINT = /^(>=|<=|>|<|=)?\s*(\S+)$/

/** True when `version` is inside a GitHub style range. An unreadable range matches nothing. */
export function inRange(version: string, range: string): boolean {
  const parts = range
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((part) => {
    const m = CONSTRAINT.exec(part)
    if (!m) return false
    const d = compareVersions(version, m[2]!)
    switch (m[1] ?? '=') {
      case '>=':
        return d >= 0
      case '>':
        return d > 0
      case '<=':
        return d <= 0
      case '<':
        return d < 0
      default:
        return d === 0
    }
  })
}

const affects = (advisory: KnownAdvisory, version: string) =>
  advisory.ranges.some((range) => inRange(version, range))

/** Upper bounds of `<` constraints: the first version past each range. */
function upperBounds(ranges: readonly string[]): string[] {
  return ranges.flatMap((range) =>
    range.split(',').flatMap((part) => {
      const m = /^<\s*(\S+)$/.exec(part.trim())
      return m ? [m[1]!] : []
    }),
  )
}

const uniq = (values: Iterable<string>) => [...new Set(values)]

/** A stored advisory as the check reads it; null when it was withdrawn. */
export function knownFromRow(row: AdvisoryRow): KnownAdvisory | null {
  if (row.withdrawnAt) return null
  return {
    key: row.advisoryKey,
    ids: uniq([row.advisoryKey, row.ghsaId ?? '', ...row.cveIds, ...row.aliases].filter(Boolean)),
    ranges: row.vulnerableRanges,
    fixed: uniq([
      ...(row.firstPatchedVersion ? [row.firstPatchedVersion] : []),
      ...upperBounds(row.vulnerableRanges),
    ]),
  }
}

/** An OSV record's ranges for one package; null when withdrawn or about another package. */
export function knownFromOsv(
  vuln: OsvVulnerability,
  ecosystem: OsvEcosystem,
  packageName: string,
): KnownAdvisory | null {
  if (vuln.withdrawn) return null
  const ranges: string[] = []
  const fixed: string[] = []
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== packageName || affected.package.ecosystem !== ecosystem) continue
    for (const version of affected.versions ?? []) ranges.push(`= ${version}`)
    for (const range of affected.ranges ?? []) {
      for (const hit of rangeIntervals(range)) {
        ranges.push(formatRange(hit))
        if (hit.fixed) fixed.push(hit.fixed)
      }
    }
  }
  if (ranges.length === 0) return null
  const ids = uniq([vuln.id, ...(vuln.aliases ?? [])])
  return {
    key: ids.find((id) => id.startsWith('GHSA-')) ?? vuln.id,
    ids,
    ranges: uniq(ranges),
    fixed: uniq(fixed),
  }
}

/** Merges copies of one advisory (stored and OSV), matched by any shared id. First key wins. */
export function mergeKnown(lists: readonly (readonly KnownAdvisory[])[]): KnownAdvisory[] {
  const out: KnownAdvisory[] = []
  for (const advisory of lists.flat()) {
    const same = out.find((a) => a.ids.some((id) => advisory.ids.includes(id)))
    if (!same) {
      out.push({ ...advisory })
      continue
    }
    same.ids = uniq([...same.ids, ...advisory.ids])
    same.ranges = uniq([...same.ranges, ...advisory.ranges])
    same.fixed = uniq([...same.fixed, ...advisory.fixed])
  }
  return out
}

const keysOf = (advisories: readonly KnownAdvisory[]) => uniq(advisories.map((a) => a.key)).sort()

/** True when `version` stays in the semver line of `base`: a patch or minor away. */
const sameLine = (base: string, version: string) => {
  const level = bumpLevel(base, version)
  return level === 'patch' || level === 'minor'
}

export interface ChooseTargetInput {
  ecosystem: string
  packageName: string
  /** Highest first patched version among the step's findings. */
  minimum: string
  facts: TargetFacts
}

/**
 * The lowest candidate at or above `minimum`, in its semver line, with no known advisory.
 * Candidates are `minimum` and the fixed versions of every advisory known for the package.
 * A candidate stored data does not rule out is asked of OSV first (`pending`). When OSV cannot
 * answer, the candidate is taken unchecked. When every candidate is affected, the target stays
 * `minimum` and the check says which advisories still affect it, rather than crossing a major.
 */
export function chooseTarget(input: ChooseTargetInput): TargetChoice {
  const { ecosystem, packageName, minimum, facts } = input
  if (osvEcosystemOf(ecosystem) === null || !EXACT.test(minimum)) return { kind: 'skip' }
  const answers = facts.osv?.get(packageKey(ecosystem, packageName))
  const answered = [...(answers?.values() ?? [])].filter((a) => a !== 'unavailable')
  const known = mergeKnown([facts.stored(ecosystem, packageName), ...answered])
  const candidates = uniq([minimum, ...known.flatMap((a) => a.fixed)])
    .filter(
      (v) =>
        EXACT.test(v) &&
        compareVersions(v, minimum) >= 0 &&
        sameLine(minimum, v) &&
        (v === minimum || !isPrerelease(v)),
    )
    .sort(compareVersions)

  const passed: KnownAdvisory[] = []
  for (const version of candidates) {
    const affecting = known.filter((a) => affects(a, version))
    if (affecting.length > 0) {
      passed.push(...affecting)
      continue
    }
    // With OSV off only stored advisories count, and that is the user's choice: no note.
    const answer = facts.osv === null ? 'off' : answers?.get(version)
    if (answer === undefined) {
      return { kind: 'pending', query: { ecosystem, packageName, version } }
    }
    const status = typeof answer === 'string' ? 'unchecked' : 'clean'
    const note =
      answer === 'unavailable'
        ? `Hinomi could not check ${packageName} ${version} against OSV, so an advisory of that version may be missing.`
        : null
    return {
      kind: 'done',
      to: version,
      check: { status, minimum, avoids: keysOf(passed), stillAffected: [] },
      note,
    }
  }

  const still = known.filter((a) => affects(a, minimum))
  const next = still
    .flatMap((a) => a.fixed)
    .filter((v) => compareVersions(v, minimum) > 0 && !sameLine(minimum, v))
    .sort(compareVersions)[0]
  const keys = keysOf(still)
  return {
    kind: 'done',
    to: minimum,
    check: { status: 'affected', minimum, avoids: [], stillAffected: keys },
    note:
      `${packageName} ${minimum} is still affected by ${keys.join(', ')}: Hinomi knows no version in the same semver line without an advisory.` +
      (next ? ` The next fix it knows, ${next}, is a semver major.` : ''),
  }
}

/**
 * Asks OSV about each queried version in one batch (the client splits and paces it) and
 * records the answers in `answers`. When OSV fails, every query is answered `unavailable`.
 * Returns the error message, if any, for the caller to log.
 */
export async function askOsv(
  client: OsvClient,
  queries: readonly TargetQuery[],
  answers: Map<string, Map<string, OsvAnswer>>,
): Promise<string | null> {
  const record = (q: TargetQuery, answer: OsvAnswer) => {
    const key = packageKey(q.ecosystem, q.packageName)
    const map = answers.get(key) ?? new Map<string, OsvAnswer>()
    map.set(q.version, answer)
    answers.set(key, map)
  }
  const asked = queries.flatMap((q) => {
    const ecosystem = osvEcosystemOf(q.ecosystem)
    return ecosystem ? [{ q, ecosystem }] : []
  })
  try {
    const idLists = await client.queryBatch(
      asked.map(({ q, ecosystem }) => ({
        package: { name: q.packageName, ecosystem },
        version: q.version,
      })),
    )
    const ids = uniq(idLists.flat())
    const details = await client.getVulnerabilities(ids)
    const byId = new Map(ids.map((id, i) => [id, details[i]!]))
    asked.forEach(({ q, ecosystem }, i) => {
      const found = (idLists[i] ?? []).flatMap((id) => {
        const vuln = byId.get(id)
        const known = vuln ? knownFromOsv(vuln, ecosystem, q.packageName) : null
        return known ? [known] : []
      })
      record(q, found)
    })
    return null
  } catch (error) {
    for (const { q } of asked) record(q, 'unavailable')
    return errorMessage(error)
  }
}
