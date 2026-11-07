import { crc32, inflateRawSync } from 'node:zlib'
import { FixPayloadError, parseFixResult, type FixResultV1, type FixRunKind } from '@hinomi/shared'

// The result artifact of a fix run: the `apply` job uploads its `.hinomi/` folder (the result
// file and fix.patch) as one artifact, which GitHub serves as a zip. Only the result file is
// read, with a small zip reader over node:zlib instead of a zip library: the archive is a few
// kilobytes with two entries, stored or deflated, never zip64 or encrypted.

/** Artifact name prefix the reusable workflow uploads under: `hinomi-fix-<correlation id>`. */
export const FIX_RESULT_ARTIFACT_PREFIX = 'hinomi-fix-'
/** The name the first design sketch used; still accepted so an older workflow pin is read. */
export const LEGACY_FIX_RESULT_ARTIFACT = 'hinomi-result'
/** The result file inside the artifact. */
export const FIX_RESULT_FILE = 'hinomi-result.json'
/** Largest artifact zip downloaded. A result with every check tail is well under 100 KiB. */
export const MAX_RESULT_ARTIFACT_BYTES = 4 * 1024 * 1024
/** Largest result file read out of the zip, after inflating. */
export const MAX_RESULT_FILE_BYTES = 2 * 1024 * 1024

/** Artifact name prefix of the majors job: `hinomi-majors-<correlation id>`. */
export const MAJORS_RESULT_ARTIFACT_PREFIX = 'hinomi-majors-'

/** The artifact names a run's result may have, preferred first. */
export function fixResultArtifactNames(correlationId: string, kind: FixRunKind = 'fix'): string[] {
  if (kind === 'majors') return [`${MAJORS_RESULT_ARTIFACT_PREFIX}${correlationId}`]
  return [`${FIX_RESULT_ARTIFACT_PREFIX}${correlationId}`, LEGACY_FIX_RESULT_ARTIFACT]
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const ZIP64_MARK = 0xffffffff

function malformed(message: string, cause?: unknown): FixPayloadError {
  return new FixPayloadError('malformed', `The result artifact ${message}`, {
    ...(cause !== undefined && { cause }),
  })
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE
  const first = Math.max(0, last - MAX_COMMENT)
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at
  }
  throw malformed('is not a zip file')
}

interface CentralEntry {
  name: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

function* centralEntries(zip: Uint8Array, view: DataView): Generator<CentralEntry> {
  const eocd = findEndOfCentralDirectory(view)
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw malformed('has a broken central directory')
    }
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    yield {
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
      name: decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)),
    }
    at += 46 + nameLength + extraLength + commentLength
  }
}

function entryData(zip: Uint8Array, view: DataView, entry: CentralEntry, maxBytes: number) {
  if (entry.flags & 0x1) throw malformed(`entry ${entry.name} is encrypted`)
  if (entry.size === ZIP64_MARK || entry.compressedSize === ZIP64_MARK) {
    throw malformed(`entry ${entry.name} is a zip64 entry`)
  }
  if (entry.size > maxBytes) {
    throw malformed(`entry ${entry.name} is larger than ${maxBytes} bytes`)
  }
  const local = entry.localOffset
  if (local + 30 > zip.byteLength || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw malformed(`entry ${entry.name} has no local header`)
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  const end = start + entry.compressedSize
  if (end > zip.byteLength) throw malformed(`entry ${entry.name} is cut short`)
  const raw = zip.subarray(start, end)
  let data: Uint8Array
  if (entry.method === 0) data = raw
  else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes })
    } catch (error) {
      throw malformed(`entry ${entry.name} could not be inflated`, error)
    }
  } else throw malformed(`entry ${entry.name} uses compression method ${entry.method}`)
  if (data.byteLength !== entry.size || crc32(data) !== entry.crc) {
    throw malformed(`entry ${entry.name} does not match its checksum`)
  }
  return data
}

/**
 * The bytes of the first zip entry whose path `wanted` accepts, or null when there is none.
 * Throws FixPayloadError `malformed` for a broken, encrypted, zip64 or oversized entry.
 */
export function readZipEntry(
  zip: Uint8Array,
  wanted: (path: string) => boolean,
  maxBytes: number,
): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  if (zip.byteLength < EOCD_SIZE) throw malformed('is not a zip file')
  for (const entry of centralEntries(zip, view)) {
    if (entry.name.endsWith('/') || !wanted(entry.name)) continue
    return entryData(zip, view, entry, maxBytes)
  }
  return null
}

/**
 * The fix result inside an artifact zip: `hinomi-result.json` at the root (or in one folder),
 * parsed and validated with parseFixResult. Throws FixPayloadError: `malformed` for a broken
 * zip, a missing file or bad JSON, `unsupported_version` for a result schema Hinomi does not
 * know.
 */
export function readFixResultZip(zip: Uint8Array): FixResultV1 {
  const bytes = readZipEntry(
    zip,
    (path) => path === FIX_RESULT_FILE || path.endsWith(`/${FIX_RESULT_FILE}`),
    MAX_RESULT_FILE_BYTES,
  )
  if (!bytes) throw malformed(`has no ${FIX_RESULT_FILE}`)
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw malformed(`has a ${FIX_RESULT_FILE} that is not JSON`, error)
  }
  return parseFixResult(json)
}
