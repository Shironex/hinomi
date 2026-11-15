import type {
  DeploymentFacts,
  DeploymentKind,
  DeploymentRecord,
  DeploymentSourceKind,
  DeployRecord,
  SourceCapabilities,
} from '@hinomi/shared'
import type { ImageScanProbe, ResourceScanResult } from './image-scan.js'

// The deployment source interface (docs/design/phase-2.md section 9.1, docs/sources.md). The scan
// reads deployments from every enabled source through it and never asks which kind it is: the
// records are already normalised, and what a kind can tell is declared in its capabilities.

/** What is stored for a deployment from an earlier read. */
export interface CachedFacts {
  /** The source's change marker the facts were read at (Coolify: `updated_at`); null forces a read. */
  version: string | null
  facts: DeploymentFacts | null
}

/** Reads a source's own image scan results (the scan's image scan, `scan/image-scan.ts`). */
export interface ImageScanReader {
  /** Once per instance and scan: whether it has results at all. */
  probe(): Promise<ImageScanProbe>
  /** One resource's images and findings, by its id in the source. */
  resource(kind: DeploymentKind, externalId: string): Promise<ResourceScanResult>
}

/** Recent deploys of one deployment, or why there is no list (said in words the UI can show). */
export type DeployHistoryRead = { ok: true; items: DeployRecord[] } | { ok: false; reason: string }

/** One configured instance of a deployment source, bound to its credential. */
export interface DeploymentSource {
  /** The row in `sources`. */
  readonly sourceId: number
  readonly kind: DeploymentSourceKind
  /** The configured name, set as `source` on every record. */
  readonly name: string
  readonly capabilities: SourceCapabilities
  /**
   * Every deployment the source reports, normalised. Throws when the source cannot be read at
   * all; the scan records the error on the source and leaves its deployments as they are.
   * `externalId` is unique within the source.
   */
  inventory(): Promise<DeploymentRecord[]>
  /** Recent deploys, newest first. Absent: the source keeps no deploy history. Never throws for a source problem. */
  deployHistory?: (
    deployment: { kind: DeploymentKind; externalId: string },
    limit: number,
  ) => Promise<DeployHistoryRead>
  /** The source's own image scan results. Absent: only the registry SBOM half can cover its images. */
  imageScan?: ImageScanReader
}

/**
 * What opening a source needs, already read from storage. The credential is read lazily, so a
 * token that cannot be decrypted fails the first call (recorded like any source error), not the
 * whole scan.
 */
export interface DeploymentSourceConfig {
  sourceId: number
  name: string
  baseUrl: string | null
  /** The stored token; throws when it is missing or cannot be read. */
  token: () => string
  /** Facts stored from earlier reads by external id, read when the inventory starts. */
  cachedFacts?: () => ReadonlyMap<string, CachedFacts>
  /** Per request timeout, for interactive reads (the deploy history). */
  timeoutMs?: number
  fetch?: typeof fetch
}

/** One kind of deployment source: its declared capabilities and how to open an instance. */
export interface DeploymentSourceFactory {
  kind: DeploymentSourceKind
  capabilities: SourceCapabilities
  open(config: DeploymentSourceConfig): DeploymentSource
}
