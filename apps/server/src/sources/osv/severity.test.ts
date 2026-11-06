import { describe, expect, it } from 'vitest'
import { compareVersions, formatRange, matchRange } from './semver.js'
import { cvss3BaseScore, deriveSeverity, severityFromScore } from './severity.js'

describe('cvss3BaseScore', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N', 5.4],
    ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
    ['CVSS:3.0/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N', 3.1],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s scores %d', (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score)
  })

  it('returns null for v4 or broken vectors', () => {
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBe(
      null,
    )
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L')).toBe(null)
  })
})

describe('severity', () => {
  it('bands scores with GitHub words', () => {
    expect([9, 7, 4, 0.1].map(severityFromScore)).toEqual(['critical', 'high', 'moderate', 'low'])
  })

  it('prefers the database word over the vector and keeps the raw value', () => {
    expect(
      deriveSeverity({
        id: 'X',
        database_specific: { severity: 'MODERATE' },
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      }),
    ).toMatchObject({ severity: 'moderate', severityRaw: 'MODERATE', cvss: { score: 9.8 } })
  })

  it('keeps an unscored v4 vector and reports unknown', () => {
    const vector = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
    expect(deriveSeverity({ id: 'X', severity: [{ type: 'CVSS_V4', score: vector }] })).toEqual({
      severity: 'unknown',
      severityRaw: vector,
      cvss: { score: null, vector },
    })
  })
})

describe('semver ranges', () => {
  it('orders prereleases before the release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
  })

  const range = {
    type: 'SEMVER',
    events: [{ fixed: '2.1.5' }, { introduced: '2.0.0' }, { introduced: '0' }, { fixed: '1.9.4' }],
  }

  it('finds the interval holding the version regardless of event order', () => {
    expect(matchRange(range, '1.0.0')).toEqual({
      introduced: null,
      fixed: '1.9.4',
      lastAffected: null,
    })
    expect(matchRange(range, '1.9.4')).toBe(null)
    expect(matchRange(range, '2.1.0')).toEqual({
      introduced: '2.0.0',
      fixed: '2.1.5',
      lastAffected: null,
    })
    expect(matchRange(range, '2.1.5')).toBe(null)
    expect(matchRange(range, '2.1.5-rc.1')).not.toBe(null)
  })

  it('formats ranges like GitHub', () => {
    expect(formatRange({ introduced: null, fixed: '1.9.4', lastAffected: null })).toBe('< 1.9.4')
    expect(formatRange({ introduced: '1.0.0', fixed: null, lastAffected: null })).toBe('>= 1.0.0')
    expect(formatRange({ introduced: null, fixed: null, lastAffected: null })).toBe('>= 0')
  })
})
