import type { OsvEcosystem, OsvQuery, OsvVulnerability } from '@hinomi/shared'
import type { ImageFinding } from '../sources/coolify/index.js'
import { deriveSeverity, mapLimit, matchDependency, type OsvClient } from '../sources/osv/index.js'
import type { ImagePackage } from '../sources/registry/index.js'

// Matches the packages of an image SBOM on OSV and turns the hits into the same source neutral
// ImageFinding the Coolify results become. One querybatch tells which packages have any record;
// only those are asked again for the full records (one request per vulnerable package, not one
// per vulnerability). Language packages get the same local version check as lockfile findings.
// Distribution versions (Debian, Alpine, Ubuntu) cannot be compared locally, so OSV's own
// matching is trusted for them, as long as the record names the package in that release.

/** Vulnerable packages asked for full records per image at most; past that the result is partial. */
export const MAX_VULNERABLE_PACKAGES = 500
/** Findings kept per image at most; past that the result is partial. */
export const MAX_IMAGE_FINDINGS = 2000
const QUERY_CONCURRENCY = 4
const MAX_TITLE = 200

const CVE_ID = /^CVE-\d{4}-\d{4,}$/i

export interface ImageMatch {
  findings: ImageFinding[]
  /** More vulnerable packages or findings than the caps: some were not read. */
  capped: boolean
}

const queryOf = (pkg: ImagePackage): OsvQuery => ({
  package: { name: pkg.name, ecosystem: pkg.ecosystem },
  version: pkg.version,
})

function titleOf(vuln: OsvVulnerability): string | null {
  const text = vuln.summary?.trim() || vuln.details?.trim().split('\n')[0]?.trim()
  if (!text) return null
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 3)}...` : text
}

/** The first fixed version a record names for the package in its release, when it names one. */
function trustedFix(vuln: OsvVulnerability, pkg: ImagePackage): string | null | undefined {
  let named = false
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== pkg.name || affected.package.ecosystem !== pkg.ecosystem)
      continue
    named = true
    for (const range of affected.ranges ?? []) {
      const fixed = range.events.find((e) => e.fixed)?.fixed
      if (fixed) return fixed
    }
  }
  // undefined: the record is not about this package in this release.
  return named ? null : undefined
}

/** The finding of one record on one package, or null when it does not apply. */
export function imageFindingOf(
  vuln: OsvVulnerability,
  pkg: ImagePackage,
  imageRef: string,
): ImageFinding | null {
  if (vuln.withdrawn) return null
  let fixedIn: string | null
  if (pkg.localCheck) {
    const match = matchDependency(vuln, {
      name: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem as OsvEcosystem,
      scope: 'runtime',
      direct: false,
    })
    if (!match) return null
    fixedIn = match.firstPatched
  } else {
    const fix = trustedFix(vuln, pkg)
    if (fix === undefined) return null
    fixedIn = fix
  }
  const ids = [...new Set([vuln.id, ...(vuln.aliases ?? []), ...(vuln.upstream ?? [])])]
    .map((id) => id.trim())
    .filter((id) => id !== '' && id.length <= 500)
    .slice(0, 100)
  const { severity, cvss } = deriveSeverity(vuln)
  return {
    id: vuln.id,
    displayId: CVE_ID.test(vuln.id) ? null : (ids.find((id) => CVE_ID.test(id)) ?? null),
    ids,
    title: titleOf(vuln),
    severity,
    packageName: pkg.name,
    version: pkg.version,
    packageType: pkg.packageType,
    ecosystem: pkg.storedEcosystem,
    fixedIn,
    state: fixedIn ? 'fixed' : 'no_fix',
    ignoreReason: null,
    kev: false,
    epss: null,
    risk: null,
    cvssScore: cvss?.score ?? null,
    advisoryUrl: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
    imageRef,
  }
}

const GHSA_ID = /^GHSA-/i

/**
 * One finding per vulnerability of a package: OSV often returns a GHSA record and an ecosystem
 * record (`GO-...`) for the same issue. Keyed like lockfile matches (GHSA alias, else CVE, else
 * the id), the GHSA record wins.
 */
function dedupe(
  vulns: readonly OsvVulnerability[],
  pkg: ImagePackage,
  imageRef: string,
): ImageFinding[] {
  const byKey = new Map<string, ImageFinding>()
  for (const vuln of vulns) {
    const finding = imageFindingOf(vuln, pkg, imageRef)
    if (!finding) continue
    const key =
      finding.ids.find((id) => GHSA_ID.test(id)) ??
      finding.ids.find((id) => CVE_ID.test(id)) ??
      finding.id
    const previous = byKey.get(key)
    if (!previous || (!GHSA_ID.test(previous.id) && GHSA_ID.test(finding.id))) {
      byKey.set(key, finding)
    }
  }
  return [...byKey.values()]
}

/** Matches an image's packages on OSV. Throws when OSV fails (the caller leaves things alone). */
export async function matchImagePackages(
  client: OsvClient,
  packages: readonly ImagePackage[],
  imageRef: string,
): Promise<ImageMatch> {
  if (packages.length === 0) return { findings: [], capped: false }
  const hits = await client.queryBatch(packages.map(queryOf))
  const vulnerable = packages.filter((_, i) => (hits[i]?.length ?? 0) > 0)
  let capped = vulnerable.length > MAX_VULNERABLE_PACKAGES
  const asked = vulnerable.slice(0, MAX_VULNERABLE_PACKAGES)
  const records = await mapLimit(asked, QUERY_CONCURRENCY, (pkg) =>
    client.queryPackage(queryOf(pkg)),
  )
  const findings: ImageFinding[] = []
  asked.forEach((pkg, i) => {
    for (const finding of dedupe(records[i] ?? [], pkg, imageRef)) {
      if (findings.length >= MAX_IMAGE_FINDINGS) {
        capped = true
        return
      }
      findings.push(finding)
    }
  })
  return { findings, capped }
}
