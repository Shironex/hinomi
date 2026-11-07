import { gunzipSync, gzipSync } from 'node:zlib'
import {
  imageSbomUnavailableReasonSchema,
  parseImageRef,
  type ImageSbomUnavailableReason,
} from '@hinomi/shared'
import { z } from 'zod'
import type { DeploymentRow } from '../db/schema.js'
import {
  coverageNoteFindingKey,
  type HttpCacheRepository,
  type Repositories,
} from '../repository/index.js'
import type { ImageFinding, ResourceScan } from '../sources/coolify/index.js'
import type { OsvClient } from '../sources/osv/index.js'
import {
  DEFAULT_MAX_PACKAGES,
  RegistryError,
  registryTarget,
  targetName,
  type ImageSbom,
  type ImageSbomRead,
  type ImageSbomReader,
  type RegistryTarget,
} from '../sources/registry/index.js'
import type { FindingChange } from './apply.js'
import { errorMessage } from './collect.js'
import { matchImagePackages, MAX_IMAGE_FINDINGS, type ImageMatch } from './image-sbom-match.js'
import { markFixed, reopenIfFixed } from './state.js'

// The registry SBOM half of the image scan (docs/design/phase-2.md section 6, option C plus D).
// For an image only deployment Coolify does not cover, each image it runs is looked up in its
// registry; the SBOM attestation's packages are matched on OSV and come back as a ResourceScan,
// the same shape Coolify's results have, so image-scan.ts writes both the same way.
// - An image digest that did not change is not read again: what its SBOM said (or that it has
//   none) is kept in the http cache, one entry per image reference, with the digest as its etag.
// - An image without an SBOM opens the `image_sbom_unavailable` note with the reason; nothing
//   fails silently. A failed read (network, rate limit) leaves findings alone until next scan.

/** Images read per deployment at most (the containers of a service). */
export const MAX_IMAGES_PER_DEPLOYMENT = 10
const UNAVAILABLE = 'image_sbom_unavailable' as const
const CACHE_PREFIX = 'image-sbom:v1:'
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_DETAIL = 500

/** An image of a deployment the scan found no SBOM for, and why. */
export interface UnavailableImage {
  imageRef: string
  reason: ImageSbomUnavailableReason
  detail: string
}

export type SbomOutcome =
  /** At least one image had an SBOM: write `scan`; `incomplete` keeps unlisted findings open. */
  | { status: 'scanned'; scan: ResourceScan; incomplete: boolean; missing: UnavailableImage[] }
  /** No image had an SBOM. `retry`: a read failed, so leave findings and notes as they are. */
  | { status: 'none'; missing: UnavailableImage[]; retry: boolean }
  /** OSV failed: nothing can be matched this scan. */
  | { status: 'osv_failed'; error: string }

export interface SbomScanner {
  scan(deployment: DeploymentRow): Promise<SbomOutcome>
  /** Images read from the registry, taken from the cache, and found without an SBOM. */
  readonly stats: { read: number; cached: number; unavailable: number }
}

export interface SbomScannerOptions {
  reader: ImageSbomReader
  /** Null when OSV is switched off: every image then says `osv_off`. */
  osv: OsvClient | null
  httpCache: HttpCacheRepository
  now: Date
}

type ImageRead =
  | { kind: 'sbom'; imageRef: string; sbom: ImageSbom }
  | { kind: 'none'; image: UnavailableImage }
  | { kind: 'error'; image: UnavailableImage }

const short = (text: string) =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text

const packageSchema = z.object({
  ecosystem: z.string().max(200),
  name: z.string().max(1000),
  version: z.string().max(1000),
  packageType: z.string().max(100),
  storedEcosystem: z.string().max(200),
  localCheck: z.boolean(),
})

const cachedReadSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('sbom'),
    sbom: z.object({
      digest: z.string().max(200),
      platform: z.string().max(400),
      format: z.enum(['spdx', 'cyclonedx']),
      packages: z.array(packageSchema).max(DEFAULT_MAX_PACKAGES),
      truncated: z.boolean(),
      unreadable: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    status: z.literal('none'),
    reason: imageSbomUnavailableReasonSchema,
    detail: z.string().max(2000),
  }),
])

/** The image references a deployment runs: `deployments.image`, comma separated for services. */
export function imageRefsOf(deployment: Pick<DeploymentRow, 'image'>): string[] {
  const refs = (deployment.image ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(refs)].slice(0, MAX_IMAGES_PER_DEPLOYMENT)
}

/** Reasons a digest always gives the same answer for, so they are cached with it. */
const CACHED_ERRORS: ReadonlySet<RegistryError['code']> = new Set(['too_large', 'invalid'])

function unavailableOf(
  imageRef: string,
  error: unknown,
): Extract<ImageRead, { kind: 'none' | 'error' }> {
  if (error instanceof RegistryError && error.code !== 'failed') {
    return {
      kind: 'none',
      image: { imageRef, reason: error.code, detail: short(error.message) },
    }
  }
  return {
    kind: 'error',
    image: { imageRef, reason: 'error', detail: short(errorMessage(error)) },
  }
}

function cacheKey(target: RegistryTarget): string {
  return `${CACHE_PREFIX}${targetName(target)}`
}

function readCache(
  httpCache: HttpCacheRepository,
  key: string,
  digest: string,
): ImageSbomRead | null {
  const hit = httpCache.get(key)
  if (!hit || hit.etag !== digest) return null
  try {
    const text = gunzipSync(hit.body, { maxOutputLength: MAX_CACHE_BYTES }).toString('utf8')
    const parsed = cachedReadSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeCache(
  httpCache: HttpCacheRepository,
  key: string,
  digest: string,
  read: ImageSbomRead,
  now: Date,
): void {
  httpCache.put({
    key,
    etag: digest,
    lastModified: null,
    fetchedAt: now,
    status: read.status === 'sbom' ? 200 : 404,
    body: gzipSync(Buffer.from(JSON.stringify(read), 'utf8')),
  })
}

/**
 * One scanner per scan. The same image (by reference) is read once, and the same SBOM (by
 * digest and platform) is matched on OSV once, however many deployments run it.
 */
export function createSbomScanner(options: SbomScannerOptions): SbomScanner {
  const { reader, osv, httpCache, now } = options
  const stats = { read: 0, cached: 0, unavailable: 0 }
  const reads = new Map<string, Promise<ImageRead>>()
  const matches = new Map<string, Promise<ImageMatch>>()

  async function readImage(imageRef: string): Promise<ImageRead> {
    const ref = parseImageRef(imageRef)
    const target = ref && registryTarget(ref)
    if (!target) {
      return {
        kind: 'none',
        image: {
          imageRef,
          reason: 'unparsable_ref',
          detail: 'The image reference cannot be read (a variable left in it, or an odd host).',
        },
      }
    }
    let digest: string
    try {
      digest = await reader.resolveDigest(target)
    } catch (error) {
      return unavailableOf(imageRef, error)
    }
    const key = cacheKey(target)
    let read = readCache(httpCache, key, digest)
    if (read) stats.cached++
    else {
      try {
        read = await reader.read(target, digest)
      } catch (error) {
        const failed = unavailableOf(imageRef, error)
        if (error instanceof RegistryError && CACHED_ERRORS.has(error.code)) {
          const { reason, detail } = failed.image
          writeCache(httpCache, key, digest, { status: 'none', reason, detail }, now)
        }
        return failed
      }
      stats.read++
      writeCache(httpCache, key, digest, read, now)
    }
    return read.status === 'sbom'
      ? { kind: 'sbom', imageRef, sbom: read.sbom }
      : { kind: 'none', image: { imageRef, reason: read.reason, detail: read.detail } }
  }

  function readOnce(imageRef: string): Promise<ImageRead> {
    let pending = reads.get(imageRef)
    if (!pending) {
      pending = readImage(imageRef)
      reads.set(imageRef, pending)
    }
    return pending
  }

  function matchOnce(client: OsvClient, image: Extract<ImageRead, { kind: 'sbom' }>) {
    const key = `${image.sbom.digest}\u0000${image.sbom.platform}`
    let pending = matches.get(key)
    if (!pending) {
      pending = matchImagePackages(client, image.sbom.packages, image.imageRef)
      matches.set(key, pending)
    }
    return pending
  }

  async function scan(deployment: DeploymentRow): Promise<SbomOutcome> {
    const refs = imageRefsOf(deployment)
    if (refs.length === 0) {
      const missing: UnavailableImage[] = [
        {
          imageRef: deployment.image ?? '',
          reason: 'unparsable_ref',
          detail: 'The source names no image for this deployment.',
        },
      ]
      return { status: 'none', missing, retry: false }
    }
    if (!osv) {
      const detail = 'OSV is switched off, so the packages of an SBOM cannot be matched.'
      const missing = refs.map((imageRef) => ({ imageRef, reason: 'osv_off' as const, detail }))
      return { status: 'none', missing, retry: false }
    }
    const images: ImageRead[] = []
    for (const ref of refs) images.push(await readOnce(ref))
    const sboms = images.filter((i): i is Extract<ImageRead, { kind: 'sbom' }> => i.kind === 'sbom')
    const missing = images.flatMap((i) => (i.kind === 'sbom' ? [] : [i.image]))
    stats.unavailable += missing.length
    const failed = images.some((i) => i.kind === 'error')
    if (sboms.length === 0) return { status: 'none', missing, retry: failed }

    let matched: ImageMatch[]
    try {
      matched = await Promise.all(sboms.map((image) => matchOnce(osv, image)))
    } catch (error) {
      return { status: 'osv_failed', error: `image SBOM scan: ${errorMessage(error)}` }
    }
    const findings: ImageFinding[] = matched.flatMap((m) => m.findings)
    const scan: ResourceScan = {
      offReason: null,
      images: sboms.map((image) => ({
        imageRef: image.imageRef,
        status: 'completed',
        scannedAt: now,
        truncated: image.sbom.truncated,
      })),
      findings: findings.slice(0, MAX_IMAGE_FINDINGS),
      truncatedImages: sboms.filter((i) => i.sbom.truncated).map((i) => i.imageRef),
      capped: findings.length > MAX_IMAGE_FINDINGS || matched.some((m) => m.capped),
      unreadable: sboms.reduce((sum, i) => sum + i.sbom.unreadable, 0),
    }
    // An image without an SBOM this time says nothing about the advisories it had.
    return { status: 'scanned', scan, incomplete: missing.length > 0, missing }
  }

  return { scan, stats }
}

function lastDetails(repositories: Repositories, findingId: number): string | null {
  const event = repositories.findings.listEvents(findingId).find((e) => e.type === 'details')
  return event ? JSON.stringify(event.data ?? null) : null
}

/**
 * Opens (or reopens) the `image_sbom_unavailable` note of a deployment with the reason per image.
 * The reasons go into a `details` event whenever they change.
 */
export function openUnavailableNote(
  repositories: Repositories,
  deploymentId: number,
  missing: readonly UnavailableImage[],
  now: Date,
): FindingChange[] {
  const { findings } = repositories
  const { finding, created } = findings.observe(
    { kind: 'coverage_note', coverageNoteType: UNAVAILABLE, deploymentId },
    now,
  )
  const data = { images: missing.slice(0, MAX_IMAGES_PER_DEPLOYMENT) }
  if (created || lastDetails(repositories, finding.id) !== JSON.stringify(data)) {
    findings.addEvent({ findingId: finding.id, type: 'details', actor: 'system', data, at: now })
  }
  if (created) return [{ findingId: finding.id, change: 'opened' }]
  return reopenIfFixed(findings, finding, now)
    ? [{ findingId: finding.id, change: 'reopened' }]
    : []
}

/** Resolves the `image_sbom_unavailable` note of a deployment, if one is open. */
export function resolveUnavailableNote(
  repositories: Repositories,
  deploymentId: number,
  now: Date,
  data: Record<string, unknown>,
): FindingChange[] {
  const existing = repositories.findings.getByKey(coverageNoteFindingKey(UNAVAILABLE, deploymentId))
  if (!existing || !markFixed(repositories.findings, existing, now, data)) return []
  return [{ findingId: existing.id, change: 'fixed' }]
}
