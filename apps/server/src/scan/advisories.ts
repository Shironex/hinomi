import type { AdvisoryRecord, OsvAdvisoryMatch, Reporter } from '@hinomi/shared'
import type { AdvisoryRow } from '../db/schema.js'
import type { AdvisoriesRepository, UpsertAdvisoryInput } from '../repository/index.js'
import type { ImageFinding } from '../sources/coolify/index.js'

/**
 * Ecosystem names as stored on advisories: GitHub's lowercase words. OSV
 * spells Rust `crates.io`; everything else already matches.
 */
export function normalizeEcosystem(ecosystem: string): string {
  return ecosystem === 'crates.io' ? 'rust' : ecosystem
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const uniq = (values: readonly string[]) => [...new Set(values)]

export function advisoryFromGithub(record: AdvisoryRecord): UpsertAdvisoryInput {
  return {
    advisoryKey: record.ghsaId,
    ghsaId: record.ghsaId,
    cveIds: uniq(record.cveIds),
    aliases: [],
    ecosystem: normalizeEcosystem(record.ecosystem),
    packageName: record.package,
    severity: record.severity,
    cvssScore: record.cvss,
    cvssVector: null,
    summary: record.summary,
    description: record.description ?? null,
    url: `https://github.com/advisories/${encodeURIComponent(record.ghsaId)}`,
    vulnerableRanges: record.vulnerableRange ? [record.vulnerableRange] : [],
    firstPatchedVersion: record.firstPatched,
    publishedAt: parseDate(record.publishedAt),
    withdrawnAt: null,
  }
}

export function advisoryFromOsv(match: OsvAdvisoryMatch): UpsertAdvisoryInput {
  return {
    advisoryKey: match.ghsaId ?? match.osvId,
    ghsaId: match.ghsaId,
    cveIds: uniq(match.cveIds),
    aliases: uniq([match.osvId, ...match.aliases]),
    ecosystem: normalizeEcosystem(match.ecosystem),
    packageName: match.package,
    severity: match.severity,
    cvssScore: match.cvss?.score ?? null,
    cvssVector: match.cvss?.vector ?? null,
    summary: match.summary,
    description: match.description ?? null,
    url: match.url,
    vulnerableRanges: match.vulnerableRange ? [match.vulnerableRange] : [],
    firstPatchedVersion: match.firstPatched,
    publishedAt: parseDate(match.publishedAt),
    withdrawnAt: null,
  }
}

const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/i
const CVE_ID = /^CVE-\d{4}-\d{4,}$/i

/**
 * An advisory from an image scan finding. The key is the GHSA alias when there is one (so it
 * joins what GitHub and OSV report), else the scanner's display id or id. OS package types keep
 * their own ecosystem name (`deb`, `apk`, `rpm`), see ecosystemOfPackageType.
 */
export function advisoryFromImage(finding: ImageFinding): UpsertAdvisoryInput {
  const ghsaId = finding.ids.find((id) => GHSA_ID.test(id)) ?? null
  return {
    advisoryKey: ghsaId ?? finding.displayId ?? finding.id,
    ghsaId,
    cveIds: uniq(finding.ids.filter((id) => CVE_ID.test(id)).map((id) => id.toUpperCase())),
    aliases: finding.ids,
    ecosystem: normalizeEcosystem(finding.ecosystem),
    packageName: finding.packageName,
    severity: finding.severity,
    cvssScore: finding.cvssScore,
    cvssVector: null,
    summary: finding.title,
    description: null,
    url: finding.advisoryUrl,
    vulnerableRanges: [],
    firstPatchedVersion: finding.fixedIn,
    publishedAt: null,
    withdrawnAt: null,
  }
}

/** Every id an advisory is known by, for the dedupe lookup. */
function idsOf(input: UpsertAdvisoryInput): string[] {
  return uniq(
    [
      input.advisoryKey,
      input.ghsaId ?? '',
      ...(input.cveIds ?? []),
      ...(input.aliases ?? []),
    ].filter(Boolean),
  )
}

/** The stored advisory for the same vulnerability and package, matched by GHSA, CVE or alias. */
export function findExistingAdvisory(
  advisories: AdvisoriesRepository,
  input: UpsertAdvisoryInput,
): AdvisoryRow | undefined {
  for (const id of idsOf(input)) {
    const hit = advisories
      .findByAnyId(id)
      .find((row) => row.ecosystem === input.ecosystem && row.packageName === input.packageName)
    if (hit) return hit
  }
  return undefined
}

/**
 * Merges what a source reports into a stored advisory. Ids are unioned and
 * the stored key is kept. GitHub is authoritative for severity and details;
 * OSV only fills what is missing (or an unknown severity).
 */
export function mergeAdvisory(
  existing: AdvisoryRow,
  incoming: UpsertAdvisoryInput,
  reporter: Reporter,
): UpsertAdvisoryInput {
  const authoritative = reporter === 'github'
  const pick = <T>(current: T | null, next: T | null | undefined): T | null =>
    authoritative ? (next ?? current) : (current ?? next ?? null)
  const severity =
    authoritative || existing.severity === 'unknown'
      ? (incoming.severity ?? existing.severity)
      : existing.severity
  return {
    advisoryKey: existing.advisoryKey,
    ghsaId: existing.ghsaId ?? incoming.ghsaId ?? null,
    cveIds: uniq([...existing.cveIds, ...(incoming.cveIds ?? [])]),
    aliases: uniq([...existing.aliases, ...(incoming.aliases ?? [])]),
    ecosystem: existing.ecosystem,
    packageName: existing.packageName,
    severity,
    cvssScore: pick(existing.cvssScore, incoming.cvssScore),
    cvssVector: pick(existing.cvssVector, incoming.cvssVector),
    summary: pick(existing.summary, incoming.summary),
    description: pick(existing.description, incoming.description),
    url: pick(existing.url, incoming.url),
    vulnerableRanges: uniq([...existing.vulnerableRanges, ...(incoming.vulnerableRanges ?? [])]),
    firstPatchedVersion: pick(existing.firstPatchedVersion, incoming.firstPatchedVersion),
    publishedAt: pick(existing.publishedAt, incoming.publishedAt),
    withdrawnAt: existing.withdrawnAt,
  }
}

/** Upserts an advisory, deduped across sources by GHSA, CVE and aliases. */
export function saveAdvisory(
  advisories: AdvisoriesRepository,
  input: UpsertAdvisoryInput,
  reporter: Reporter,
): AdvisoryRow {
  const existing = findExistingAdvisory(advisories, input)
  return advisories.upsert(existing ? mergeAdvisory(existing, input, reporter) : input)
}
