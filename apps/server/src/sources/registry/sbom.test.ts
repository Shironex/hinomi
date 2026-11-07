import { describe, expect, it } from 'vitest'
import { RegistryError } from './client.js'
import { readSbom, sbomFormatOf } from './sbom.js'

const SUBJECT = `sha256:${'a'.repeat(64)}`
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const spdx = (packages: unknown[], subject = 'a'.repeat(64)) => ({
  _type: 'https://in-toto.io/Statement/v0.1',
  predicateType: 'https://spdx.dev/Document',
  subject: [{ name: 'pkg:docker/kestrel-co/edge-api@2.3.0', digest: { sha256: subject } }],
  predicate: { spdxVersion: 'SPDX-2.3', packages },
})
const purlRef = (locator: string) => ({
  externalRefs: [
    { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: locator },
  ],
})

function rejects(body: unknown, code: string) {
  let error: unknown = null
  try {
    readSbom(Buffer.isBuffer(body) ? body : bytes(body), SUBJECT, 100)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(RegistryError)
  expect(error).toMatchObject({ code })
}

describe('sbomFormatOf', () => {
  it('knows SPDX and CycloneDX predicates, versioned or not', () => {
    expect(sbomFormatOf('https://spdx.dev/Document')).toBe('spdx')
    expect(sbomFormatOf('https://spdx.dev/Document/v2.3')).toBe('spdx')
    expect(sbomFormatOf('https://cyclonedx.org/bom/v1.5')).toBe('cyclonedx')
    expect(sbomFormatOf('https://slsa.dev/provenance/v1')).toBeNull()
  })
})

describe('readSbom', () => {
  it('reads the package URLs of an SPDX statement, unique, and counts odd entries', () => {
    const result = readSbom(
      bytes(
        spdx([
          { name: 'sbom' },
          purlRef('pkg:apk/alpine/musl@1.2.5-r0?distro=alpine-3.20.2'),
          purlRef('pkg:apk/alpine/musl@1.2.5-r0?distro=alpine-3.20.2'),
          { externalRefs: [{ referenceType: 'cpe23Type', referenceLocator: 'cpe:2.3:a:x' }] },
          { externalRefs: 'pkg:npm/odd@1.0.0' },
          'not an object',
        ]),
      ),
      SUBJECT,
      100,
    )
    expect(result).toEqual({
      format: 'spdx',
      purls: ['pkg:apk/alpine/musl@1.2.5-r0?distro=alpine-3.20.2'],
      truncated: false,
      unreadable: 2,
    })
  })

  it('reads nested CycloneDX components', () => {
    const result = readSbom(
      bytes({
        predicateType: 'https://cyclonedx.org/bom',
        subject: [{ digest: { sha256: 'a'.repeat(64) } }],
        predicate: {
          bomFormat: 'CycloneDX',
          components: [
            { purl: 'pkg:npm/edge-utils@2.0.0', components: [{ purl: 'pkg:npm/edge-core@1.1.0' }] },
            { name: 'no purl' },
          ],
        },
      }),
      SUBJECT,
      100,
    )
    expect(result.format).toBe('cyclonedx')
    expect(result.purls).toEqual(['pkg:npm/edge-utils@2.0.0', 'pkg:npm/edge-core@1.1.0'])
  })

  it('unwraps a DSSE envelope', () => {
    const statement = spdx([purlRef('pkg:npm/edge-utils@2.0.0')])
    const envelope = {
      payloadType: 'application/vnd.in-toto+json',
      payload: bytes(statement).toString('base64'),
      signatures: [],
    }
    expect(readSbom(bytes(envelope), SUBJECT, 100).purls).toEqual(['pkg:npm/edge-utils@2.0.0'])
    rejects({ ...envelope, payloadType: 'text/plain' }, 'invalid')
  })

  it('caps the package count and says the result is truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) => purlRef(`pkg:npm/p${i}@1.0.0`))
    const result = readSbom(bytes(spdx(many)), SUBJECT, 3)
    expect(result.purls).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('refuses a statement about another image, a non SBOM predicate and broken JSON', () => {
    rejects(spdx([], 'b'.repeat(64)), 'invalid')
    rejects({ ...spdx([]), predicateType: 'https://slsa.dev/provenance/v1' }, 'invalid')
    rejects(Buffer.from('{not json'), 'invalid')
    rejects(
      { predicateType: 'https://spdx.dev/Document', predicate: { packages: 'none' } },
      'invalid',
    )
  })

  it('never reads a subject digest from the prototype, and leaves Object.prototype alone', () => {
    // A subject whose digest has no own sha256: `__proto__` in JSON is an own key, not a prototype.
    const text = `{"predicateType":"https://spdx.dev/Document","subject":[{"digest":{"__proto__":{"sha256":"${'a'.repeat(64)}"}}}],"predicate":{"packages":[{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"externalRefs":[]}]}}`
    rejects(Buffer.from(text), 'invalid')
    const ok = text.replace('{"__proto__":{"sha256"', '{"sha256"').replace(`"}}}]`, `"}}]`)
    expect(() => readSbom(Buffer.from(ok), SUBJECT, 100)).not.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).sha256).toBeUndefined()
  })
})
