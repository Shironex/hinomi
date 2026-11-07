import type { AdvisorySeverity, DeploymentKind, ImageFixState } from '@hinomi/shared'
import { z } from 'zod'
import type { CoolifyClient } from './client.js'
import { CoolifyError } from './errors.js'

// Coolify's own image scan results (newer Coolify builds only):
//   GET /vulnerabilities                       every resource with its stored security status
//   GET /{applications|services|databases}/{uuid}/vulnerabilities   one resource's images and findings
// Both need only the read ability. The response is untrusted input: every field is checked with
// zod, entries that do not parse are counted and dropped, and names from it are only ever used as
// Map keys or plain values, never as keys of a plain object.

/** Findings asked per page; Coolify allows at most 200. */
const PER_PAGE = 200
/** Pages read per resource at most: past 2000 findings the result counts as partial. */
const DEFAULT_MAX_PAGES = 10

const shortText = z.string().max(500)
const optionalNumber = z.number().finite().nullable().optional()

const probeSchema = z.object({
  is_image_scanning_allowed: z.boolean().optional(),
  resources: z
    .array(
      z.object({
        uuid: shortText,
        security: z
          .object({ checked_at: z.string().max(100).nullable().optional() })
          .nullable()
          .optional(),
      }),
    )
    .optional(),
})

const imageSchema = z.object({
  image_ref: z.string().max(1000),
  scan_status: shortText.nullable().optional(),
  scanned_at: z.string().max(100).nullable().optional(),
  truncated: z.boolean().optional(),
})

const findingSchema = z.object({
  id: shortText.min(1),
  display_id: shortText.nullable().optional(),
  aliases: z.array(shortText).max(100).nullable().optional(),
  title: z.string().max(2000).nullable().optional(),
  severity: shortText.nullable().optional(),
  package: shortText.min(1),
  version: shortText.min(1),
  package_type: z.string().max(100).nullable().optional(),
  fixed_in: shortText.nullable().optional(),
  state: shortText.nullable().optional(),
  ignore: z
    .object({ reason: z.string().max(2000).nullable().optional() })
    .nullable()
    .optional(),
  kev: z.boolean().nullable().optional(),
  epss: optionalNumber,
  risk: optionalNumber,
  cvss_score: optionalNumber,
  advisory_url: z.string().max(2000).nullable().optional(),
  image_ref: z.string().max(1000).nullable().optional(),
})

const resourceSchema = z.object({
  off_reason: shortText.nullable().optional(),
  images: z.array(z.unknown()).max(500).optional(),
  findings: z.array(z.unknown()).optional(),
  pagination: z.object({ total: z.number().int().nonnegative().optional() }).nullable().optional(),
})

/** Whether an instance has image scan results at all, asked once per instance and scan. */
export type ImageScanProbe =
  | {
      status: 'available'
      /** Coolify's change marker per resource uuid (its security status `checked_at`), when given. */
      checkedAt: ReadonlyMap<string, string | null>
    }
  /** `no_endpoint`: this Coolify is older than the endpoint (404). `disabled`: scanning is off on the instance. */
  | { status: 'unavailable'; reason: 'no_endpoint' | 'disabled' }
  /** The token may not read the results (403). */
  | { status: 'forbidden'; message: string }

/** One finding as Hinomi stores it, source neutral. */
export interface ImageFinding {
  /** The scanner's id (a CVE, GHSA or distribution advisory id). */
  id: string
  displayId: string | null
  /** Every id the finding is known by, `id` and `displayId` included, without duplicates. */
  ids: string[]
  title: string | null
  severity: AdvisorySeverity
  packageName: string
  version: string
  /** As the scanner names it (`deb`, `apk`, `npm`, `gomod`, ...). */
  packageType: string
  /** The advisory ecosystem: OSV's name lowered to Hinomi's when one exists, else the package type. */
  ecosystem: string
  fixedIn: string | null
  state: ImageFixState
  /** Why it was ignored in the scanner, when it was. */
  ignoreReason: string | null
  kev: boolean
  epss: number | null
  risk: number | null
  cvssScore: number | null
  /** Only http and https links are kept. */
  advisoryUrl: string | null
  imageRef: string | null
}

export interface ScannedImage {
  imageRef: string
  /** `completed` when the scan finished; queued, running and failed scans have no findings. */
  status: string | null
  scannedAt: Date | null
  /** Coolify capped this image's finding list. */
  truncated: boolean
}

export interface ResourceScan {
  /** Why Coolify does not scan the resource (`instance`, `server`, `application`); null when it does. */
  offReason: string | null
  images: ScannedImage[]
  findings: ImageFinding[]
  /** Images whose finding list Coolify capped. */
  truncatedImages: string[]
  /** More findings than Hinomi reads per resource: the rest were not read. */
  capped: boolean
  /** Entries in the response that did not parse and were dropped. */
  unreadable: number
}

export type ResourceScanResult =
  | { status: 'ok'; scan: ResourceScan }
  /** The resource is gone (deleted since the inventory was read). */
  | { status: 'not_found' }
  | { status: 'forbidden'; message: string }

const PATHS: Record<DeploymentKind, string> = {
  application: 'applications',
  service: 'services',
  database: 'databases',
}

export const FORBIDDEN_MESSAGE =
  'The Coolify token may not read image scan results (403). Give the token the read permission ' +
  '(a read only token is enough) on the projects of the image only deployments.'

/**
 * Asks once per instance whether it has image scan results. 404 means the Coolify version has no
 * image scan, 403 a token permission gap; any other failure throws (a transient error is
 * retried on the next scan).
 */
export async function probeImageScan(client: CoolifyClient): Promise<ImageScanProbe> {
  let body: unknown
  try {
    body = await client.getJson('/vulnerabilities')
  } catch (err) {
    if (err instanceof CoolifyError && err.code === 'not_found') {
      return { status: 'unavailable', reason: 'no_endpoint' }
    }
    if (err instanceof CoolifyError && err.code === 'forbidden') {
      return { status: 'forbidden', message: FORBIDDEN_MESSAGE }
    }
    throw err
  }
  const parsed = probeSchema.safeParse(body)
  if (!parsed.success) {
    throw new CoolifyError(
      'invalid_response',
      'Coolify returned an unexpected shape for /vulnerabilities',
    )
  }
  if (parsed.data.is_image_scanning_allowed === false) {
    return { status: 'unavailable', reason: 'disabled' }
  }
  const checkedAt = new Map<string, string | null>()
  for (const resource of parsed.data.resources ?? []) {
    checkedAt.set(resource.uuid, resource.security?.checked_at ?? null)
  }
  return { status: 'available', checkedAt }
}

/**
 * Package types as scanners name them (Trivy and Grype spellings) to the advisory ecosystem
 * Hinomi stores, so an image advisory joins one a lockfile or GitHub already reported. OS
 * package types (`deb`, `apk`, `rpm`) need the distribution and release to name an OSV
 * ecosystem, which a finding does not carry, so they are kept as given.
 */
const ECOSYSTEMS: ReadonlyMap<string, string> = new Map([
  ['npm', 'npm'],
  ['node-pkg', 'npm'],
  ['yarn', 'npm'],
  ['pnpm', 'npm'],
  ['gomod', 'Go'],
  ['gobinary', 'Go'],
  ['go-module', 'Go'],
  ['python-pkg', 'PyPI'],
  ['python', 'PyPI'],
  ['pip', 'PyPI'],
  ['pipenv', 'PyPI'],
  ['poetry', 'PyPI'],
  ['uv', 'PyPI'],
  ['gem', 'RubyGems'],
  ['gemspec', 'RubyGems'],
  ['bundler', 'RubyGems'],
  ['cargo', 'rust'],
  ['rust-binary', 'rust'],
  ['rust-crate', 'rust'],
  ['composer', 'Packagist'],
  ['php-composer', 'Packagist'],
  ['jar', 'Maven'],
  ['pom', 'Maven'],
  ['gradle', 'Maven'],
  ['java-archive', 'Maven'],
  ['nuget', 'NuGet'],
  ['dotnet-core', 'NuGet'],
  ['dotnet-deps', 'NuGet'],
  ['pub', 'Pub'],
  ['dart-pub', 'Pub'],
  ['hex', 'Hex'],
])

export function ecosystemOfPackageType(packageType: string): string {
  return ECOSYSTEMS.get(packageType.toLowerCase()) ?? packageType
}

const SEVERITIES: ReadonlyMap<string, AdvisorySeverity> = new Map([
  ['critical', 'critical'],
  ['high', 'high'],
  ['medium', 'moderate'],
  ['moderate', 'moderate'],
  ['low', 'low'],
])

const FIX_STATES: ReadonlyMap<string, ImageFixState> = new Map([
  ['fixed', 'fixed'],
  ['no_fix', 'no_fix'],
  ['ignored', 'ignored'],
])

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null)

function toFinding(raw: z.infer<typeof findingSchema>): ImageFinding {
  const displayId = blankToNull(raw.display_id)
  const packageType = blankToNull(raw.package_type) ?? 'unknown'
  const ids = [
    ...new Set([raw.id, displayId ?? '', ...(raw.aliases ?? [])].map((s) => s.trim())),
  ].filter(Boolean)
  return {
    id: raw.id.trim(),
    displayId,
    ids,
    title: blankToNull(raw.title),
    severity: SEVERITIES.get((raw.severity ?? '').toLowerCase()) ?? 'unknown',
    packageName: raw.package,
    version: raw.version,
    packageType,
    ecosystem: ecosystemOfPackageType(packageType),
    fixedIn: blankToNull(raw.fixed_in),
    // An unknown state counts as `fixed` (a fix may exist): it stays open, like any advisory.
    state: FIX_STATES.get(raw.state ?? '') ?? 'fixed',
    ignoreReason: blankToNull(raw.ignore?.reason),
    kev: raw.kev === true,
    epss: raw.epss ?? null,
    risk: raw.risk ?? null,
    cvssScore:
      raw.cvss_score !== null &&
      raw.cvss_score !== undefined &&
      raw.cvss_score >= 0 &&
      raw.cvss_score <= 10
        ? raw.cvss_score
        : null,
    advisoryUrl: httpUrl(raw.advisory_url),
    imageRef: blankToNull(raw.image_ref),
  }
}

function toImage(raw: z.infer<typeof imageSchema>): ScannedImage {
  return {
    imageRef: raw.image_ref,
    status: raw.scan_status ?? null,
    scannedAt: parseDate(raw.scanned_at),
    truncated: raw.truncated === true,
  }
}

/** Parses each entry on its own: one odd entry is dropped and counted, not the whole page. */
function parseEach<T>(items: readonly unknown[], schema: z.ZodType<T>): { ok: T[]; bad: number } {
  const ok: T[] = []
  let bad = 0
  for (const item of items) {
    const parsed = schema.safeParse(item)
    if (parsed.success) ok.push(parsed.data)
    else bad++
  }
  return { ok, bad }
}

/**
 * Reads one resource's image scan: images and every finding, page by page (at most `maxPages`).
 * A 404 means the resource is gone, a 403 a permission gap; other failures throw.
 */
export async function fetchResourceScan(
  client: CoolifyClient,
  kind: DeploymentKind,
  uuid: string,
  options: { maxPages?: number } = {},
): Promise<ResourceScanResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const base = `/${PATHS[kind]}/${encodeURIComponent(uuid)}/vulnerabilities?per_page=${PER_PAGE}`
  const findings: ImageFinding[] = []
  let images: ScannedImage[] = []
  let offReason: string | null = null
  let unreadable = 0
  let rowsRead = 0
  let capped = false

  for (let page = 1; ; page++) {
    const path = `${base}&page=${page}`
    let body: unknown
    try {
      body = await client.getJson(path)
    } catch (err) {
      if (err instanceof CoolifyError && err.code === 'not_found') return { status: 'not_found' }
      if (err instanceof CoolifyError && err.code === 'forbidden') {
        return { status: 'forbidden', message: FORBIDDEN_MESSAGE }
      }
      throw err
    }
    const parsed = resourceSchema.safeParse(body)
    if (!parsed.success) {
      throw new CoolifyError('invalid_response', `Coolify returned an unexpected shape for ${path}`)
    }
    const data = parsed.data
    if (page === 1) {
      offReason = blankToNull(data.off_reason)
      const parsedImages = parseEach(data.images ?? [], imageSchema)
      images = parsedImages.ok.map(toImage)
      unreadable += parsedImages.bad
    }
    const rows = data.findings ?? []
    const parsedFindings = parseEach(rows, findingSchema)
    findings.push(...parsedFindings.ok.map(toFinding))
    unreadable += parsedFindings.bad
    rowsRead += rows.length

    // Done when a page comes back short (or empty) or the total is reached.
    const total = data.pagination?.total
    if (rows.length < PER_PAGE || (total !== undefined && rowsRead >= total)) break
    // A full page with no total, or the page limit: more may follow that is not read.
    if (total === undefined || page >= maxPages) {
      capped = true
      break
    }
  }

  return {
    status: 'ok',
    scan: {
      offReason,
      images,
      findings,
      truncatedImages: images.filter((i) => i.truncated).map((i) => i.imageRef),
      capped,
      unreadable,
    },
  }
}
