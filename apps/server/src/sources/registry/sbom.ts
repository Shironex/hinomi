import { z } from 'zod'
import { RegistryError } from './client.js'

// The SBOM an attestation layer carries: an in-toto statement (raw, as BuildKit stores it, or in
// a DSSE envelope) whose predicate is an SPDX 2 document or a CycloneDX BOM. Only package URLs
// are read. Each package entry is checked on its own: one odd entry is counted, not fatal.

export type SbomFormat = 'spdx' | 'cyclonedx'

/** The SBOM format of an in-toto predicate type, or null when it is not an SBOM. */
export function sbomFormatOf(predicateType: string): SbomFormat | null {
  if (predicateType.startsWith('https://spdx.dev/Document')) return 'spdx'
  if (predicateType.startsWith('https://cyclonedx.org/bom')) return 'cyclonedx'
  return null
}

export interface SbomContents {
  format: SbomFormat
  /** Unique package URLs, at most the cap. */
  purls: string[]
  /** More packages than the cap: the rest were not read. */
  truncated: boolean
  /** Package entries that did not parse. */
  unreadable: number
}

const purlText = z.string().max(1000)

const envelopeSchema = z.object({
  payloadType: z.string().max(200),
  payload: z.string(),
})

const statementSchema = z.object({
  predicateType: z.string().max(500),
  subject: z
    .array(z.object({ digest: z.unknown().optional() }))
    .max(100)
    .optional(),
  predicate: z.unknown(),
})

const spdxSchema = z.object({ packages: z.array(z.unknown()).optional() })
const spdxPackageSchema = z.object({
  externalRefs: z
    .array(z.object({ referenceType: z.string().max(100), referenceLocator: purlText }))
    .max(100)
    .optional(),
})

const cyclonedxSchema = z.object({ components: z.array(z.unknown()).optional() })
const cyclonedxComponentSchema = z.object({
  purl: purlText.optional(),
  components: z.array(z.unknown()).optional(),
})

/** CycloneDX components nest; deeper levels than this are not read. */
const MAX_DEPTH = 4

/** An own string property of an untrusted object, never one from its prototype. */
export function ownString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new RegistryError('invalid', `${what} is not JSON`)
  }
}

/** The statement, unwrapped from a DSSE envelope when it comes in one. */
function statementOf(body: unknown): z.infer<typeof statementSchema> {
  let value = body
  const envelope = envelopeSchema.safeParse(body)
  if (envelope.success) {
    if (envelope.data.payloadType !== 'application/vnd.in-toto+json') {
      throw new RegistryError(
        'invalid',
        'the attestation envelope does not hold an in-toto statement',
      )
    }
    value = parseJson(
      Buffer.from(envelope.data.payload, 'base64').toString('utf8'),
      'the attestation payload',
    )
  }
  const parsed = statementSchema.safeParse(value)
  if (!parsed.success)
    throw new RegistryError('invalid', 'the attestation is not an in-toto statement')
  return parsed.data
}

class Collector {
  readonly purls = new Set<string>()
  truncated = false
  unreadable = 0
  constructor(private readonly max: number) {}

  add(purl: string): void {
    if (this.purls.has(purl)) return
    if (this.purls.size >= this.max) {
      this.truncated = true
      return
    }
    this.purls.add(purl)
  }
}

function readSpdx(predicate: unknown, into: Collector): void {
  const doc = spdxSchema.safeParse(predicate)
  if (!doc.success) throw new RegistryError('invalid', 'the SPDX document has no package list')
  for (const raw of doc.data.packages ?? []) {
    if (into.truncated) return
    const pkg = spdxPackageSchema.safeParse(raw)
    if (!pkg.success) {
      into.unreadable++
      continue
    }
    for (const ref of pkg.data.externalRefs ?? []) {
      if (ref.referenceType === 'purl') into.add(ref.referenceLocator)
    }
  }
}

function readCyclonedx(components: readonly unknown[], into: Collector, depth: number): void {
  for (const raw of components) {
    if (into.truncated) return
    const component = cyclonedxComponentSchema.safeParse(raw)
    if (!component.success) {
      into.unreadable++
      continue
    }
    if (component.data.purl) into.add(component.data.purl)
    if (component.data.components && depth < MAX_DEPTH) {
      readCyclonedx(component.data.components, into, depth + 1)
    }
  }
}

/**
 * Reads an attestation layer. `subjectDigest` is the platform image the attestation must be
 * about: a statement naming other subjects only is refused as invalid.
 */
export function readSbom(bytes: Buffer, subjectDigest: string, maxPackages: number): SbomContents {
  const statement = statementOf(parseJson(bytes.toString('utf8'), 'the attestation'))
  const format = sbomFormatOf(statement.predicateType)
  if (!format) throw new RegistryError('invalid', 'the attestation does not hold an SBOM')
  const [algorithm, hex] = subjectDigest.split(':')
  if (
    statement.subject &&
    statement.subject.length > 0 &&
    !statement.subject.some((s) => algorithm && ownString(s.digest, algorithm) === hex)
  ) {
    throw new RegistryError(
      'invalid',
      'the SBOM is about another image than the one it is attached to',
    )
  }
  const into = new Collector(maxPackages)
  if (format === 'spdx') readSpdx(statement.predicate, into)
  else {
    const bom = cyclonedxSchema.safeParse(statement.predicate)
    if (!bom.success) throw new RegistryError('invalid', 'the CycloneDX BOM has no component list')
    readCyclonedx(bom.data.components ?? [], into, 1)
  }
  return { format, purls: [...into.purls], truncated: into.truncated, unreadable: into.unreadable }
}
