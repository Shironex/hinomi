import { createRegistryClient, type RegistryClientOptions } from './client.js'
import { readImageSbom, type ImageSbomRead, type ReadImageSbomOptions } from './read.js'
import type { RegistryTarget } from './reference.js'

/** Reads image SBOMs from OCI registries (see image-sbom.ts in scan). */
export interface ImageSbomReader {
  /** The digest a reference points at now. */
  resolveDigest(target: RegistryTarget): Promise<string>
  /** The SBOM of the image at that digest; a failed read throws a RegistryError. */
  read(target: RegistryTarget, digest: string): Promise<ImageSbomRead>
}

/** One reader per scan: pull tokens are kept for the life of the reader. */
export function createImageSbomReader(
  options: RegistryClientOptions & ReadImageSbomOptions = {},
): ImageSbomReader {
  const client = createRegistryClient(options)
  return {
    resolveDigest: (target) => client.resolveDigest(target),
    read: (target, digest) => readImageSbom(client, target, digest, options),
  }
}
