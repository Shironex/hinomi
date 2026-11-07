import type { ImageSbomUnavailableReason } from '@hinomi/shared'
import { z } from 'zod'
import { isDigest, MANIFEST_MEDIA_TYPES, RegistryError, type RegistryClient } from './client.js'
import { imagePackageOf, parsePurl, type ImagePackage } from './purl.js'
import type { RegistryTarget } from './reference.js'
import { ownString, readSbom, sbomFormatOf, type SbomFormat } from './sbom.js'

// The SBOM of an image, the way BuildKit attaches it: the image index lists, next to each
// platform's image, an attestation manifest (`vnd.docker.reference.type: attestation-manifest`,
// `vnd.docker.reference.digest: <platform image>`) whose layers are in-toto statements; the one
// with an SPDX or CycloneDX predicate is the SBOM.

/** Platforms read, in order of preference; else the index's first image. */
export const DEFAULT_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const
/** Package URLs read per image at most; past that the result is partial. */
export const DEFAULT_MAX_PACKAGES = 5000

const ATTESTATION_TYPE = 'vnd.docker.reference.type'
const ATTESTATION_DIGEST = 'vnd.docker.reference.digest'
const PREDICATE_TYPE = 'in-toto.io/predicate-type'

const descriptorSchema = z.object({
  mediaType: z.string().max(200).optional(),
  digest: z.string().max(200),
  size: z.number().int().nonnegative().optional(),
  platform: z
    .object({
      os: z.string().max(100),
      architecture: z.string().max(100),
      variant: z.string().max(100).optional(),
    })
    .optional(),
  annotations: z.unknown().optional(),
})
type Descriptor = z.infer<typeof descriptorSchema>

const listSchema = z.object({ manifests: z.array(z.unknown()).max(1000) })
const layersSchema = z.object({ layers: z.array(z.unknown()).max(1000) })

export interface ImageSbom {
  /** The digest the reference resolved to (the image index). */
  digest: string
  /** The platform whose SBOM was read (`linux/amd64`). */
  platform: string
  format: SbomFormat
  /** Unique packages OSV can match. */
  packages: ImagePackage[]
  /** More packages than the cap: the rest were not read. */
  truncated: boolean
  /** Package entries that did not parse. */
  unreadable: number
  /** Packages OSV cannot match (an unknown type, an OS package without its release). */
  skipped: number
}

export type ImageSbomRead =
  | { status: 'sbom'; sbom: ImageSbom }
  | { status: 'none'; reason: ImageSbomUnavailableReason; detail: string }

export interface ReadImageSbomOptions {
  platforms?: readonly string[]
  maxPackages?: number
}

/** An own string annotation of an untrusted descriptor. */
const annotation = (descriptor: Descriptor, key: string) => ownString(descriptor.annotations, key)

function descriptors(items: readonly unknown[]): Descriptor[] {
  const out: Descriptor[] = []
  for (const item of items) {
    const parsed = descriptorSchema.safeParse(item)
    if (parsed.success && isDigest(parsed.data.digest)) out.push(parsed.data)
  }
  return out
}

const platformName = (d: Descriptor) =>
  d.platform
    ? `${d.platform.os}/${d.platform.architecture}${d.platform.variant ? `/${d.platform.variant}` : ''}`
    : 'unknown'

function isList(mediaType: string | null, body: unknown): boolean {
  if (
    mediaType === MANIFEST_MEDIA_TYPES.ociIndex ||
    mediaType === MANIFEST_MEDIA_TYPES.dockerList
  ) {
    return true
  }
  return mediaType === null && listSchema.safeParse(body).success
}

function isImageManifest(mediaType: string | null, body: unknown): boolean {
  if (
    mediaType === MANIFEST_MEDIA_TYPES.ociManifest ||
    mediaType === MANIFEST_MEDIA_TYPES.dockerManifest
  ) {
    return true
  }
  return mediaType === null && layersSchema.safeParse(body).success
}

function pickPlatform(images: Descriptor[], platforms: readonly string[]): Descriptor | null {
  for (const wanted of platforms) {
    const hit = images.find((d) => platformName(d) === wanted)
    if (hit) return hit
  }
  return images[0] ?? null
}

/** Unique OSV packages of the purls, and how many purls OSV cannot match. */
export function packagesOf(purls: readonly string[]): {
  packages: ImagePackage[]
  skipped: number
} {
  const unique = new Map<string, ImagePackage>()
  let skipped = 0
  for (const raw of purls) {
    const purl = parsePurl(raw)
    const pkg = purl && imagePackageOf(purl)
    if (!pkg) {
      skipped++
      continue
    }
    unique.set(`${pkg.ecosystem}\u0000${pkg.name}\u0000${pkg.version}`, pkg)
  }
  return { packages: [...unique.values()], skipped }
}

/**
 * Reads the SBOM of the image at `digest`. A missing SBOM is a `none` result with the reason;
 * a failed read throws a RegistryError.
 */
export async function readImageSbom(
  client: RegistryClient,
  target: RegistryTarget,
  digest: string,
  options: ReadImageSbomOptions = {},
): Promise<ImageSbomRead> {
  const top = await client.getManifest(target, digest)
  if (!isList(top.mediaType, top.body)) {
    if (isImageManifest(top.mediaType, top.body)) {
      return {
        status: 'none',
        reason: 'no_index',
        detail: 'The image has a single manifest; attestations live only in an image index.',
      }
    }
    throw new RegistryError('invalid', `the manifest of the image is not an index or an image`)
  }
  const entries = descriptors(listSchema.parse(top.body).manifests)
  const images = entries.filter(
    (d) => annotation(d, ATTESTATION_TYPE) === null && d.platform && d.platform.os !== 'unknown',
  )
  const image = pickPlatform(images, options.platforms ?? DEFAULT_PLATFORMS)
  if (!image) {
    return { status: 'none', reason: 'no_platform', detail: 'The image index lists no image.' }
  }
  const platform = platformName(image)
  const attestation = entries.find(
    (d) =>
      annotation(d, ATTESTATION_TYPE) === 'attestation-manifest' &&
      annotation(d, ATTESTATION_DIGEST) === image.digest,
  )
  if (!attestation) {
    return {
      status: 'none',
      reason: 'no_attestation',
      detail: `The image index has no attestation for ${platform}.`,
    }
  }
  const manifest = await client.getManifest(target, attestation.digest)
  const layersParsed = layersSchema.safeParse(manifest.body)
  if (!layersParsed.success) {
    throw new RegistryError('invalid', 'the attestation manifest has no layers')
  }
  const layer = descriptors(layersParsed.data.layers).find((d) => {
    const predicate = annotation(d, PREDICATE_TYPE)
    return predicate !== null && sbomFormatOf(predicate) !== null
  })
  if (!layer) {
    return {
      status: 'none',
      reason: 'no_sbom',
      detail: `The attestations for ${platform} carry no SPDX or CycloneDX SBOM.`,
    }
  }
  const contents = readSbom(
    await client.getBlob(target, layer.digest),
    image.digest,
    options.maxPackages ?? DEFAULT_MAX_PACKAGES,
  )
  const { packages, skipped } = packagesOf(contents.purls)
  return {
    status: 'sbom',
    sbom: {
      digest,
      platform,
      format: contents.format,
      packages,
      truncated: contents.truncated,
      unreadable: contents.unreadable,
      skipped,
    },
  }
}
