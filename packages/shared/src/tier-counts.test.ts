import { describe, expect, it } from 'vitest'
import { fixPlanSummarySchema } from './api.js'

describe('tier counts of stored plans', () => {
  it('reads a tier missing from an older plan as 0', () => {
    const counts = {
      blind_spot: 0,
      exposed: 1,
      internal: 0,
      public_low: 0,
      dev: 0,
      not_deployed: 0,
      patched: 0,
      coverage: 0,
    }
    const summary = fixPlanSummarySchema.parse({
      findings: {
        total: 1,
        cleared: 1,
        clearedSafely: 1,
        unfixed: 0,
        clearedByTier: counts,
        unfixedByTier: counts,
      },
      steps: { safe: 1, risky: 0 },
      unfixed: 0,
    })
    expect(summary.findings.clearedByTier.released).toBe(0)
    expect(summary.findings.clearedByTier.exposed).toBe(1)
  })
})
