import { FIX_RESULT_SCHEMA } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  MAX_RESULT_FILE_BYTES,
  fixResultArtifactNames,
  readFixResultZip,
  readZipEntry,
} from './artifact.js'
import { runnerPlan, runnerResult, zipOf } from './testing.js'

// Reading the fix result out of the artifact zip. Repos and packages are fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const repoRow = { id: 3, owner: 'kestrel-co', name: 'harbor' } as Parameters<typeof runnerPlan>[0]
const result = runnerResult(runnerPlan(repoRow, 11, T0), 'run-0c1d')
const resultJson = JSON.stringify(result)

describe('fix result artifact', () => {
  it('names the artifact after the correlation id, with the older name as a fallback', () => {
    expect(fixResultArtifactNames('run-0c1d')).toEqual(['hinomi-fix-run-0c1d', 'hinomi-result'])
  })

  it('reads the result from a deflated or a stored entry next to the patch', () => {
    for (const method of [0, 8] as const) {
      const zip = zipOf([
        { name: 'fix.patch', data: 'diff --git a/package.json b/package.json\n', method },
        { name: 'hinomi-result.json', data: resultJson, method },
      ])
      expect(readFixResultZip(zip)).toEqual(result)
    }
    expect(
      readFixResultZip(zipOf([{ name: '.hinomi/hinomi-result.json', data: resultJson }])),
    ).toEqual(result)
  })

  it('reads a single entry and answers null when it is missing', () => {
    const zip = zipOf([{ name: 'fix.patch', data: 'patch' }])
    expect(readZipEntry(zip, (p) => p === 'nope', 100)).toBeNull()
    expect(
      new TextDecoder().decode(
        readZipEntry(zip, (p) => p === 'fix.patch', 100) ?? new Uint8Array(),
      ),
    ).toBe('patch')
  })

  it('refuses a broken artifact as malformed', () => {
    const cases: [Uint8Array, RegExp][] = [
      [new TextEncoder().encode('not a zip at all, just some text here'), /not a zip/],
      [new Uint8Array(4), /not a zip/],
      [zipOf([{ name: 'fix.patch', data: 'patch' }]), /has no hinomi-result.json/],
      [zipOf([{ name: 'hinomi-result.json', data: '{"schema":' }]), /not JSON/],
      [zipOf([{ name: 'hinomi-result.json', data: resultJson, crc: 1 }]), /checksum/],
      [zipOf([{ name: 'hinomi-result.json', data: resultJson, flags: 1 }]), /encrypted/],
      [
        zipOf([{ name: 'hinomi-result.json', data: 'x'.repeat(MAX_RESULT_FILE_BYTES + 1) }]),
        /larger than/,
      ],
    ]
    for (const [zip, message] of cases) {
      expect(() => readFixResultZip(zip)).toThrow(message)
      expect(() => readFixResultZip(zip)).toThrow(
        expect.objectContaining({ name: 'FixPayloadError', code: 'malformed' }),
      )
    }
    const truncated = zipOf([{ name: 'hinomi-result.json', data: resultJson }])
    expect(() => readFixResultZip(truncated.subarray(0, 40))).toThrow()
  })

  it('refuses a result that fails the schema, or one of another version', () => {
    const invalid = zipOf([
      { name: 'hinomi-result.json', data: JSON.stringify({ ...result, steps: 'all of them' }) },
    ])
    expect(() => readFixResultZip(invalid)).toThrow(expect.objectContaining({ code: 'malformed' }))
    const newer = zipOf([
      {
        name: 'hinomi-result.json',
        data: JSON.stringify({ ...result, schema: `${FIX_RESULT_SCHEMA.slice(0, -1)}9` }),
      },
    ])
    expect(() => readFixResultZip(newer)).toThrow(
      expect.objectContaining({ code: 'unsupported_version' }),
    )
  })
})
