import type { AdvisorySeverity, ImageFixState, ImageSecurity } from '@hinomi/shared'

// Image scan results a deployment source computed itself (Coolify's own scan, see
// docs/design/phase-2.md section 6), in the source neutral shape the scan writes. The registry
// SBOM half builds the same shape, so both are written the same way.

/** Whether a source instance has image scan results at all, asked once per instance and scan. */
export type ImageScanProbe =
  | {
      status: 'available'
      /**
       * The source's change marker per resource id (Coolify: its security status `checked_at`),
       * when given. A resource whose marker did not move since the last read is not read again.
       */
      checkedAt: ReadonlyMap<string, string | null>
    }
  /**
   * `no_endpoint`: the instance is older than the endpoint (Coolify: 404). `disabled`: scanning
   * is off on the instance.
   */
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
  /** The sub resource that runs the image (Coolify: the service application or database uuid). */
  ownerUuid: string | null
}

export interface ScannedImage {
  imageRef: string
  /** The sub resource that runs the image (Coolify `owner_uuid`), null when not said. */
  ownerUuid: string | null
  /** Why a failed scan failed, as the scanner names it (Coolify `error_code`). */
  errorCode: string | null
  /** `completed` when the scan finished; queued, running and failed scans have no findings. */
  status: string | null
  scannedAt: Date | null
  /** The scanner capped this image's finding list. */
  truncated: boolean
}

export interface ResourceScan {
  /**
   * Why the source does not scan the resource (Coolify: `server` or `application`); null when it
   * does.
   */
  offReason: string | null
  /** The source's verdict on the whole resource, null when it gave none. */
  security: ImageSecurity | null
  images: ScannedImage[]
  findings: ImageFinding[]
  /** Images whose finding list the scanner capped. */
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
  /** The source asks to slow down (429): nothing more is read from it in this scan. */
  | { status: 'rate_limited'; message: string; retryAfterSeconds: number | null }
