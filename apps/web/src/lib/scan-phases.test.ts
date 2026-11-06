import { describe, expect, it } from 'vitest'
import { describeScanning, phaseCount, type ScanningStatus } from './scan-phases'

const status = (over: Partial<ScanningStatus> = {}): ScanningStatus => ({
  state: 'scanning',
  scanRunId: 7,
  startedAt: '2026-11-05T10:00:00.000Z',
  phase: 'alerts',
  done: 12,
  total: 1038,
  skipped: [],
  ...over,
})

describe('scan phases', () => {
  it('describes the phase with its count', () => {
    expect(describeScanning(status())).toBe('Fetching open alerts, 12 of 1,038 repos')
    expect(describeScanning(status({ phase: 'deployments', done: 0, total: 1 }))).toBe(
      'Reading deployments, 0 of 1 source',
    )
  })

  it('leaves the count out when the phase has none', () => {
    expect(phaseCount(status({ phase: 'ranking', done: 0, total: 0 }))).toBeNull()
    expect(describeScanning(status({ phase: 'ranking', done: 0, total: 0 }))).toBe(
      'Ranking by exposure',
    )
  })
})
