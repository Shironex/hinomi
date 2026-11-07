import type { ImageFixState, ImageScanEvidence, ImageScanMode } from '@hinomi/shared'
import type { DeploymentRow, FindingRow } from '../db/schema.js'
import {
  coverageNoteFindingKey,
  coverageNoteTypeOf,
  type Repositories,
} from '../repository/index.js'
import { mapLimit } from '../sources/osv/index.js'
import type { ImageFinding, ResourceScan } from '../sources/coolify/index.js'
import { advisoryFromImage, saveAdvisory } from './advisories.js'
import type { FindingChange } from './apply.js'
import { errorMessage } from './collect.js'
import { isImageOnly, type DeploymentIndex } from './deployments.js'
import type { CoolifyScanSource, ImageScanReader } from './sources.js'
import { markFixed, reopenIfFixed } from './state.js'

// Image scan of image only deployments (docs/design/phase-2.md section 6), from Coolify's own
// scan results. Off by default. Each covered deployment's advisories become findings reported by
// `image`, keyed per deployment; its `image_only` coverage note resolves (see applyCoverageNotes).

/**
 * Per deployment id: `true` when the image scan covers it, `null` when this scan could not tell
 * (leave the coverage note as it is). A deployment that is not in the map is not covered.
 */
export type ImageCoverage = ReadonlyMap<number, true | null>

/** Resolution note of an `image_only` coverage note the image scan covers. */
export function coveredByImageScan(mode: ImageScanMode): Record<string, unknown> {
  return { coveredBy: 'image_scan', mode }
}

export interface ImageScanError {
  sourceId: number
  /** The Coolify source name. */
  subject: string
  error: string
}

export interface ImageScanResult {
  changes: FindingChange[]
  coverage: ImageCoverage
  /** At most one per instance: the first failure (403, timeouts, odd responses). */
  errors: ImageScanError[]
  /** Instances without image scan results (older Coolify, or scanning off on the instance). */
  unavailable: { sourceId: number; subject: string; reason: 'no_endpoint' | 'disabled' }[]
  /** Deployments whose results were read and written this scan. */
  scanned: number
  /** Deployments skipped because Coolify reported nothing new since the last read. */
  unchanged: number
}

export interface ImageScanOptions {
  mode: ImageScanMode
  now: Date
  /** Resources read in parallel per instance. Defaults to 4. */
  concurrency?: number
}

const ACCEPTED_REASON = 'ignored in Coolify'
const PARTIAL = 'image_scan_partial' as const

/** Image only deployments with no manual repo mapping: the ones with an `image_only` note. */
export function imageScanTargets(index: DeploymentIndex): DeploymentRow[] {
  const unmapped = new Set(index.unmapped.map((d) => d.id))
  return index.deployments.filter((d) => isImageOnly(d) && unmapped.has(d.id))
}

/** One advisory on one deployment, possibly seen in several images. */
interface Bucket {
  advisoryId: number
  imageRefs: Set<string>
  versions: Set<string>
  states: Set<ImageFixState>
  ignoreReason: string | null
  kev: boolean
  epss: number | null
  risk: number | null
  packageType: string
}

const maxOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b)

/** `ignored` only when every image ignores it; otherwise the most actionable state. */
function fixStateOf(states: ReadonlySet<ImageFixState>): ImageFixState {
  if (states.has('fixed')) return 'fixed'
  if (states.has('no_fix')) return 'no_fix'
  return 'ignored'
}

function newestScan(scan: ResourceScan): Date | null {
  let newest: Date | null = null
  for (const image of scan.images) {
    if (image.status !== 'completed' || !image.scannedAt) continue
    if (!newest || image.scannedAt > newest) newest = image.scannedAt
  }
  return newest
}

/** `true` covered, `false` not covered, `null` a scan is still running: leave things alone. */
function coverageOf(scan: ResourceScan): boolean | null {
  if (scan.offReason !== null) return false
  if (scan.images.some((i) => i.status === 'completed')) return true
  if (scan.images.some((i) => i.status === 'queued' || i.status === 'running')) return null
  return false
}

function isComplete(scan: ResourceScan): boolean {
  return (
    !scan.capped &&
    scan.unreadable === 0 &&
    scan.truncatedImages.length === 0 &&
    scan.images.every((i) => i.status === 'completed')
  )
}

function isPartial(scan: ResourceScan): boolean {
  return scan.capped || scan.unreadable > 0 || scan.truncatedImages.length > 0
}

/** Image advisory findings of a deployment (dedupe key `...:image`). */
function imageFindingsOf(repositories: Repositories, deploymentId: number): FindingRow[] {
  return repositories.findings
    .list({ deploymentId, kind: 'advisory' })
    .filter((f) => f.dedupeKey.endsWith(':image'))
}

function bucketFindings(
  repositories: Repositories,
  findings: readonly ImageFinding[],
): Map<number, Bucket> {
  const buckets = new Map<number, Bucket>()
  for (const finding of findings) {
    const advisory = saveAdvisory(repositories.advisories, advisoryFromImage(finding), 'image')
    let bucket = buckets.get(advisory.id)
    if (!bucket) {
      bucket = {
        advisoryId: advisory.id,
        imageRefs: new Set(),
        versions: new Set(),
        states: new Set(),
        ignoreReason: null,
        kev: false,
        epss: null,
        risk: null,
        packageType: finding.packageType,
      }
      buckets.set(advisory.id, bucket)
    }
    if (finding.imageRef) bucket.imageRefs.add(finding.imageRef)
    bucket.versions.add(finding.version)
    bucket.states.add(finding.state)
    bucket.ignoreReason ??= finding.ignoreReason
    bucket.kev ||= finding.kev
    bucket.epss = maxOf(bucket.epss, finding.epss)
    bucket.risk = maxOf(bucket.risk, finding.risk)
  }
  return buckets
}

/**
 * Writes one deployment's scan result: advisories (joined to stored ones by GHSA, CVE and alias),
 * one finding per advisory, `ignored in Coolify` acceptances on first sight, fixes for findings
 * a complete result no longer lists, and the partial result note.
 */
export function applyResourceScan(
  repositories: Repositories,
  deployment: DeploymentRow,
  scan: ResourceScan,
  now: Date,
): FindingChange[] {
  const { findings } = repositories
  return repositories.db.transaction(() => {
    const changes: FindingChange[] = []
    const scannedAt = newestScan(scan)
    const seen = new Set<number>()
    for (const bucket of bucketFindings(repositories, scan.findings).values()) {
      const fixState = fixStateOf(bucket.states)
      const evidence: ImageScanEvidence = {
        imageScan: 'coolify',
        imageRefs: [...bucket.imageRefs].slice(0, 50),
        scannedAt: scannedAt?.toISOString() ?? null,
        kev: bucket.kev,
        epss: bucket.epss,
        risk: bucket.risk,
        fixState,
        packageType: bucket.packageType,
      }
      const { finding, created } = findings.observe(
        {
          kind: 'advisory',
          image: true,
          advisoryId: bucket.advisoryId,
          deploymentId: deployment.id,
          repoId: null,
          installedVersion: [...bucket.versions].sort().join(', '),
          evidence,
        },
        now,
      )
      seen.add(finding.id)
      if (created) {
        changes.push({ findingId: finding.id, change: 'opened' })
        // Ignored in Coolify: accepted on first sight only; later decisions in Hinomi win.
        if (fixState === 'ignored') {
          findings.changeState(
            finding.id,
            {
              state: 'accepted',
              reason: ACCEPTED_REASON,
              actor: 'system',
              data: { source: 'coolify', ignoreReason: bucket.ignoreReason },
            },
            now,
          )
        }
      } else if (reopenIfFixed(findings, finding, now)) {
        changes.push({ findingId: finding.id, change: 'reopened' })
      }
    }
    // Only a complete result says an advisory is gone; a partial one leaves the rest alone.
    if (isComplete(scan)) {
      for (const finding of imageFindingsOf(repositories, deployment.id)) {
        if (seen.has(finding.id)) continue
        if (markFixed(findings, finding, now, { coveredBy: ['image'] })) {
          changes.push({ findingId: finding.id, change: 'fixed' })
        }
      }
    }
    changes.push(...applyPartialNote(repositories, deployment.id, scan, now))
    return changes
  })
}

function applyPartialNote(
  repositories: Repositories,
  deploymentId: number,
  scan: ResourceScan,
  now: Date,
): FindingChange[] {
  const { findings } = repositories
  if (!isPartial(scan)) return resolvePartialNote(repositories, deploymentId, now, null)
  const { finding, created } = findings.observe(
    { kind: 'coverage_note', coverageNoteType: PARTIAL, deploymentId },
    now,
  )
  const data = {
    truncatedImages: scan.truncatedImages.slice(0, 50),
    capped: scan.capped,
    unreadable: scan.unreadable,
  }
  if (created) {
    findings.addEvent({ findingId: finding.id, type: 'details', actor: 'system', data, at: now })
    return [{ findingId: finding.id, change: 'opened' }]
  }
  return reopenIfFixed(findings, finding, now)
    ? [{ findingId: finding.id, change: 'reopened' }]
    : []
}

function resolvePartialNote(
  repositories: Repositories,
  deploymentId: number,
  now: Date,
  data: Record<string, unknown> | null,
): FindingChange[] {
  const existing = repositories.findings.getByKey(coverageNoteFindingKey(PARTIAL, deploymentId))
  if (!existing || !markFixed(repositories.findings, existing, now, data ?? undefined)) return []
  return [{ findingId: existing.id, change: 'fixed' }]
}

/** Partial notes of deployments the image scan no longer looks at (off, mapped, gone from it). */
function resolveStalePartialNotes(
  repositories: Repositories,
  targets: ReadonlySet<number>,
  mode: ImageScanMode,
  now: Date,
): FindingChange[] {
  const changes: FindingChange[] = []
  for (const note of repositories.findings.list({ kind: 'coverage_note' })) {
    if (note.state === 'fixed' || note.deploymentId === null) continue
    if (coverageNoteTypeOf(note) !== PARTIAL) continue
    if (mode !== 'off' && targets.has(note.deploymentId)) continue
    const data =
      mode === 'off' ? { checked: false, reason: 'image_scan_off' } : { reason: 'not_image_only' }
    changes.push(...resolvePartialNote(repositories, note.deploymentId, now, data))
  }
  return changes
}

/** Skip the read when Coolify's change marker did not move since the last read. */
function unchanged(deployment: DeploymentRow, checkedAt: string | null | undefined): boolean {
  if (!deployment.imageScannedAt || !checkedAt) return false
  const marker = new Date(checkedAt)
  return !Number.isNaN(marker.getTime()) && marker <= deployment.imageScannedAt
}

interface SourceRun {
  repositories: Repositories
  reader: ImageScanReader
  sourceId: number
  name: string
  targets: DeploymentRow[]
  options: ImageScanOptions
  result: ImageScanResult & { coverage: Map<number, true | null> }
}

function recordError(run: SourceRun, error: string): void {
  // One error per instance: a token gap or an outage would otherwise repeat per resource.
  if (run.result.errors.some((e) => e.sourceId === run.sourceId)) return
  run.result.errors.push({ sourceId: run.sourceId, subject: run.name, error })
}

async function scanSource(run: SourceRun): Promise<void> {
  const { repositories, reader, targets, result, options } = run
  const leaveAlone = () => targets.forEach((d) => result.coverage.set(d.id, null))
  let probe
  try {
    probe = await reader.probe()
  } catch (error) {
    recordError(run, `image scan: ${errorMessage(error)}`)
    return leaveAlone()
  }
  if (probe.status === 'unavailable') {
    result.unavailable.push({ sourceId: run.sourceId, subject: run.name, reason: probe.reason })
    return
  }
  if (probe.status === 'forbidden') {
    recordError(run, probe.message)
    return
  }
  const checkedAt = probe.checkedAt
  await mapLimit(targets, options.concurrency ?? 4, async (deployment) => {
    if (unchanged(deployment, checkedAt.get(deployment.externalId))) {
      result.coverage.set(deployment.id, true)
      result.unchanged++
      return
    }
    let read
    try {
      read = await reader.resource(deployment.kind, deployment.externalId)
    } catch (error) {
      recordError(run, `image scan of ${deployment.name}: ${errorMessage(error)}`)
      result.coverage.set(deployment.id, null)
      return
    }
    if (read.status === 'not_found') {
      // Deleted since the inventory was read: the next sync removes it.
      result.coverage.set(deployment.id, null)
      return
    }
    if (read.status === 'forbidden') {
      recordError(run, read.message)
      return
    }
    const covered = coverageOf(read.scan)
    if (covered === null) {
      result.coverage.set(deployment.id, null)
      return
    }
    if (!covered) {
      repositories.deployments.setImageScannedAt(deployment.id, null)
      return
    }
    try {
      result.changes.push(...applyResourceScan(repositories, deployment, read.scan, options.now))
      repositories.deployments.setImageScannedAt(deployment.id, newestScan(read.scan))
      result.coverage.set(deployment.id, true)
      result.scanned++
    } catch (error) {
      recordError(run, `image scan of ${deployment.name}: could not save: ${errorMessage(error)}`)
      result.coverage.set(deployment.id, null)
    }
  })
}

/**
 * Reads the image scan of every image only deployment of every Coolify source, when the mode is
 * `coolify`. Never throws: a failure leaves that instance's notes and findings as they are and
 * is returned in `errors`. A Coolify without the endpoint (404) is not an error: its
 * deployments keep their `image_only` note and the instance is listed in `unavailable`.
 */
export async function runImageScan(
  repositories: Repositories,
  coolify: readonly CoolifyScanSource[],
  index: DeploymentIndex,
  options: ImageScanOptions,
): Promise<ImageScanResult> {
  const targets = options.mode === 'coolify' ? imageScanTargets(index) : []
  const result: SourceRun['result'] = {
    changes: [],
    coverage: new Map(),
    errors: [],
    unavailable: [],
    scanned: 0,
    unchanged: 0,
  }
  for (const source of coolify) {
    const own = targets.filter((d) => d.sourceId === source.sourceId)
    if (own.length === 0 || !source.imageScan) continue
    await scanSource({
      repositories,
      reader: source.imageScan,
      sourceId: source.sourceId,
      name: source.name,
      targets: own,
      options,
      result,
    })
  }
  const targetIds = new Set(targets.map((d) => d.id))
  result.changes.push(
    ...resolveStalePartialNotes(repositories, targetIds, options.mode, options.now),
  )
  return result
}
