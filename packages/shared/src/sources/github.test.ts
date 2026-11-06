import { describe, expect, it } from 'vitest'
import { advisoryRecordSchema, repoHealthSchema } from './github.js'

describe('github source schemas', () => {
  it('accepts a normalised advisory', () => {
    const advisory = {
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      cveIds: [],
      package: 'example-lib',
      ecosystem: 'npm',
      severity: 'critical',
      cvss: null,
      summary: 'Example',
      vulnerableRange: '< 1.0.0',
      firstPatched: null,
      publishedAt: '2026-01-01T00:00:00Z',
    }
    expect(advisoryRecordSchema.parse(advisory)).toEqual(advisory)
  })

  it('rejects an unknown severity', () => {
    expect(advisoryRecordSchema.safeParse({ severity: 'severe' }).success).toBe(false)
  })

  it('keeps unknown alert settings distinct from disabled', () => {
    const base = {
      owner: 'kestrel-co',
      name: 'harbor-web',
      archived: false,
      defaultBranch: 'main',
      visibility: 'public',
      pushedAt: null,
    }
    expect(repoHealthSchema.parse({ ...base, alertsEnabled: null }).alertsEnabled).toBeNull()
    expect(repoHealthSchema.parse({ ...base, alertsEnabled: false }).alertsEnabled).toBe(false)
  })
})
