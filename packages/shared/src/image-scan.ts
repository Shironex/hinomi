import { z } from 'zod'

// Image scan of image only deployments (docs/design/phase-2.md section 6).
// Off by default; `coolify` reads the scan results a Coolify instance already
// computed. Registry SBOMs (`sbom`) join in a later slice.

export const IMAGE_SCAN_MODES = ['off', 'coolify'] as const
export const imageScanModeSchema = z.enum(IMAGE_SCAN_MODES)
export type ImageScanMode = z.infer<typeof imageScanModeSchema>
export const IMAGE_SCAN_DEFAULT_MODE: ImageScanMode = 'off'

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
  /** Tells it apart from guard evidence (which has `check`). */
  imageScan: z.literal('coolify'),
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
  /** The package type as the scanner names it (`deb`, `apk`, `npm`, `gomod`, ...). */
  packageType: z.string().max(100),
})
export type ImageScanEvidence = z.infer<typeof imageScanEvidenceSchema>
