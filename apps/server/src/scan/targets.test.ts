import type { OsvVulnerability } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import {
  chooseTarget,
  inRange,
  knownFromOsv,
  mergeKnown,
  osvEcosystemOf,
  packageKey,
  type KnownAdvisory,
  type OsvAnswer,
  type TargetFacts,
} from './targets.js'

// Made up packages and advisory ids only.

const advisory = (key: string, ranges: string[], fixed: string[] = []): KnownAdvisory => ({
  key,
  ids: [key],
  ranges,
  fixed,
})

function facts(
  stored: KnownAdvisory[],
  osv: Record<string, OsvAnswer> | null,
  pkg = 'wren-dom',
  ecosystem = 'npm',
): TargetFacts {
  return {
    stored: (eco, name) => (eco === ecosystem && name === pkg ? stored : []),
    osv:
      osv === null ? null : new Map([[packageKey(ecosystem, pkg), new Map(Object.entries(osv))]]),
  }
}

describe('inRange', () => {
  it('reads GitHub style ranges', () => {
    expect(inRange('1.2.0', '>= 1.0.0, < 1.2.3')).toBe(true)
    expect(inRange('1.2.3', '>= 1.0.0, < 1.2.3')).toBe(false)
    expect(inRange('0.9.0', '>= 1.0.0, < 1.2.3')).toBe(false)
    expect(inRange('2.0.0', '<= 2.0.0')).toBe(true)
    expect(inRange('2.0.0', '= 2.0.0')).toBe(true)
    expect(inRange('2.0.1', '> 2.0.0')).toBe(true)
    expect(inRange('5.0.0', '>= 0')).toBe(true)
    expect(inRange('1.0.0', '')).toBe(false)
  })
})

describe('knownFromOsv', () => {
  const vuln: OsvVulnerability = {
    id: 'OSV-2026-0001',
    aliases: ['GHSA-wren-0001', 'CVE-2026-0001'],
    affected: [
      {
        package: { name: 'wren-dom', ecosystem: 'npm' },
        ranges: [
          {
            type: 'SEMVER',
            events: [{ introduced: '0' }, { fixed: '1.0.4' }, { introduced: '1.1.0' }],
          },
        ],
        versions: ['0.9.9'],
      },
      { package: { name: 'other', ecosystem: 'npm' }, ranges: [] },
    ],
  }

  it('keeps every interval of the package, keyed by the GHSA alias', () => {
    expect(knownFromOsv(vuln, 'npm', 'wren-dom')).toEqual({
      key: 'GHSA-wren-0001',
      ids: ['OSV-2026-0001', 'GHSA-wren-0001', 'CVE-2026-0001'],
      ranges: ['= 0.9.9', '< 1.0.4', '>= 1.1.0'],
      fixed: ['1.0.4'],
    })
  })

  it('drops withdrawn records and records about another package', () => {
    expect(knownFromOsv({ ...vuln, withdrawn: '2026-10-01T00:00:00Z' }, 'npm', 'wren-dom')).toBe(
      null,
    )
    expect(knownFromOsv(vuln, 'crates.io', 'wren-dom')).toBe(null)
  })
})

describe('mergeKnown', () => {
  it('merges copies of one advisory matched by any id', () => {
    const stored = { ...advisory('GHSA-a', ['< 1.0.1'], ['1.0.1']), ids: ['GHSA-a', 'CVE-1'] }
    const osv = { ...advisory('OSV-1', ['>= 2.0.0, < 2.0.3'], ['2.0.3']), ids: ['OSV-1', 'CVE-1'] }
    expect(mergeKnown([[stored], [osv]])).toEqual([
      {
        key: 'GHSA-a',
        ids: ['GHSA-a', 'CVE-1', 'OSV-1'],
        ranges: ['< 1.0.1', '>= 2.0.0, < 2.0.3'],
        fixed: ['1.0.1', '2.0.3'],
      },
    ])
  })
})

describe('chooseTarget', () => {
  const base = { ecosystem: 'npm', packageName: 'wren-dom', minimum: '1.4.0' }

  it('asks OSV about the minimum before taking it', () => {
    expect(chooseTarget({ ...base, facts: facts([], {}) })).toEqual({
      kind: 'pending',
      query: { ecosystem: 'npm', packageName: 'wren-dom', version: '1.4.0' },
    })
  })

  it('moves past a minimum OSV says is affected, to the clean fix in the same line', () => {
    const bad = advisory('GHSA-wren-0002', ['>= 1.4.0, < 1.4.2'], ['1.4.2'])
    const choice = chooseTarget({ ...base, facts: facts([], { '1.4.0': [bad], '1.4.2': [] }) })
    expect(choice).toEqual({
      kind: 'done',
      to: '1.4.2',
      check: { status: 'clean', minimum: '1.4.0', avoids: ['GHSA-wren-0002'], stillAffected: [] },
      note: null,
    })
  })

  it('skips a candidate stored data rules out without asking OSV about it', () => {
    const stored = advisory('GHSA-wren-0003', ['>= 1.4.0, < 1.5.1'], ['1.5.1'])
    const choice = chooseTarget({ ...base, facts: facts([stored], {}) })
    expect(choice).toEqual({
      kind: 'pending',
      query: { ecosystem: 'npm', packageName: 'wren-dom', version: '1.5.1' },
    })
  })

  it('keeps the minimum and names the advisory when the only clean fix is a major', () => {
    const bad = advisory('GHSA-wren-0004', ['>= 1.0.0, < 2.0.0'], ['2.0.0'])
    const choice = chooseTarget({ ...base, facts: facts([], { '1.4.0': [bad] }) })
    expect(choice).toMatchObject({
      kind: 'done',
      to: '1.4.0',
      check: { status: 'affected', avoids: [], stillAffected: ['GHSA-wren-0004'] },
    })
    expect(choice.kind === 'done' && choice.note).toBe(
      'wren-dom 1.4.0 is still affected by GHSA-wren-0004: Hinomi knows no version in the same semver line without an advisory. The next fix it knows, 2.0.0, is a semver major.',
    )
  })

  it('takes a candidate unchecked, with a note, when OSV could not answer', () => {
    const choice = chooseTarget({ ...base, facts: facts([], { '1.4.0': 'unavailable' }) })
    expect(choice).toMatchObject({
      kind: 'done',
      to: '1.4.0',
      check: { status: 'unchecked', avoids: [], stillAffected: [] },
      note: 'Hinomi could not check wren-dom 1.4.0 against OSV, so an advisory of that version may be missing.',
    })
  })

  it('uses stored advisories only, without a note, when OSV is off', () => {
    const stored = advisory('GHSA-wren-0005', ['>= 1.4.0, < 1.4.1'], ['1.4.1'])
    expect(chooseTarget({ ...base, facts: facts([stored], null) })).toEqual({
      kind: 'done',
      to: '1.4.1',
      check: {
        status: 'unchecked',
        minimum: '1.4.0',
        avoids: ['GHSA-wren-0005'],
        stillAffected: [],
      },
      note: null,
    })
  })

  it('never picks a prerelease or a version below the minimum', () => {
    const bad = advisory('GHSA-wren-0006', ['>= 1.4.0, < 1.4.3'], ['1.3.9', '1.4.3-rc.1', '1.4.3'])
    const choice = chooseTarget({ ...base, facts: facts([], { '1.4.0': [bad], '1.4.3': [] }) })
    expect(choice).toMatchObject({ kind: 'done', to: '1.4.3' })
  })

  it('skips ecosystems a plan does not apply and versions that are not semver', () => {
    expect(chooseTarget({ ...base, ecosystem: 'pip', facts: facts([], {}) })).toEqual({
      kind: 'skip',
    })
    expect(chooseTarget({ ...base, minimum: '2026-10-01', facts: facts([], {}) })).toEqual({
      kind: 'skip',
    })
  })
})

describe('osvEcosystemOf', () => {
  it('maps the ecosystems the fix runner applies', () => {
    expect(osvEcosystemOf('npm')).toBe('npm')
    expect(osvEcosystemOf('rust')).toBe('crates.io')
  })

  it('is not supported by the fix runner for the wider ecosystems, under any spelling', () => {
    for (const name of [
      'go',
      'Go',
      'pip',
      'PyPI',
      'composer',
      'Packagist',
      'rubygems',
      'RubyGems',
    ]) {
      expect(osvEcosystemOf(name)).toBeNull()
    }
  })
})
