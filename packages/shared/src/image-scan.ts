import { z } from 'zod'

// Image scan of image only deployments (docs/design/phase-2.md section 6).
// Off by default; `coolify` reads the scan results a Coolify instance already
// computed. `sbom` does the same and, for the deployments Coolify does not cover,
// reads the SBOM attestation the image carries in its registry and matches its
// packages on OSV.

export const IMAGE_SCAN_MODES = ['off', 'coolify', 'sbom'] as const
export const imageScanModeSchema = z.enum(IMAGE_SCAN_MODES)
export type ImageScanMode = z.infer<typeof imageScanModeSchema>
export const IMAGE_SCAN_DEFAULT_MODE: ImageScanMode = 'off'

/** Where an image scan result came from: Coolify's own scan, or a registry SBOM matched on OSV. */
export const IMAGE_SCAN_SOURCES = ['coolify', 'sbom'] as const
export const imageScanSourceSchema = z.enum(IMAGE_SCAN_SOURCES)
export type ImageScanSource = z.infer<typeof imageScanSourceSchema>

/**
 * Why the registry SBOM scan has no SBOM for an image (the `image_sbom_unavailable` note):
 * - `unparsable_ref`: the image reference cannot be read (a variable left in it, say).
 * - `not_found`: the registry does not know the image or tag.
 * - `unauthorized`: the registry wants credentials (a private image).
 * - `no_index`: the image has a single manifest; BuildKit stores attestations only in an index.
 * - `no_platform`: the index has no image for a platform Hinomi reads.
 * - `no_attestation`: the index has no attestation for the platform's image.
 * - `no_sbom`: the attestations carry no SPDX or CycloneDX SBOM (provenance only, say).
 * - `too_large`: a manifest or the SBOM is larger than Hinomi reads.
 * - `invalid`: the registry answered something that is not a valid manifest or SBOM.
 * - `refused`: the registry pointed somewhere Hinomi does not follow (another host for its
 *   token, a private address).
 * - `osv_off`: OSV is switched off, so packages cannot be matched.
 * - `error`: the read failed (network, timeout, rate limit); it is tried again next scan.
 */
export const IMAGE_SBOM_UNAVAILABLE_REASONS = [
  'unparsable_ref',
  'not_found',
  'unauthorized',
  'no_index',
  'no_platform',
  'no_attestation',
  'no_sbom',
  'too_large',
  'invalid',
  'refused',
  'osv_off',
  'error',
] as const
export const imageSbomUnavailableReasonSchema = z.enum(IMAGE_SBOM_UNAVAILABLE_REASONS)
export type ImageSbomUnavailableReason = z.infer<typeof imageSbomUnavailableReasonSchema>

/**
 * How the scanner rates a finding's fix: `fixed` (a fix exists upstream), `no_fix` (none yet) or
 * `ignored` (someone ignored it in the scanner).
 */
export const IMAGE_FIX_STATES = ['fixed', 'no_fix', 'ignored'] as const
export const imageFixStateSchema = z.enum(IMAGE_FIX_STATES)
export type ImageFixState = z.infer<typeof imageFixStateSchema>

/**
 * Evidence of an advisory finding an image scan reported, stored on the finding. One advisory can
 * sit in several images of one deployment (the containers of a service): `imageRefs` lists them.
 */
export const imageScanEvidenceSchema = z.object({
  /** Tells it apart from guard evidence (which has `check`), and names the scan it came from. */
  imageScan: imageScanSourceSchema,
  /** Image refs the scanner found the package in, as it reports them. */
  imageRefs: z.array(z.string().max(1000)).max(50),
  /** When the newest of those images was scanned, ISO 8601; null when not said. */
  scannedAt: z.string().nullable(),
  /** Listed in the CISA Known Exploited Vulnerabilities catalog. */
  kev: z.boolean(),
  /** EPSS probability (0 to 1), null when unknown. */
  epss: z.number().nullable(),
  /** The scanner's own risk score, null when unknown. */
  risk: z.number().nullable(),
  fixState: imageFixStateSchema,
  /** The package type as the scanner names it (`deb`, `apk`, `npm`, `gomod`, ...), or the purl type. */
  packageType: z.string().max(100),
})
export type ImageScanEvidence = z.infer<typeof imageScanEvidenceSchema>
