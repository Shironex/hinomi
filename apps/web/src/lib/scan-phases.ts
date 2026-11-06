import type { ScanPhase, ScanStatusDto } from '@hinomi/shared'

export type ScanningStatus = Extract<ScanStatusDto, { state: 'scanning' }>

/** What each scan phase does, in words for the phase lines and the shell. */
export const PHASE_LABEL: Record<ScanPhase, string> = {
  deployments: 'Reading deployments',
  alerts: 'Fetching open alerts',
  lockfiles: 'Scanning lockfiles with OSV.dev',
  matching: 'Matching repos to apps',
  ranking: 'Ranking by exposure',
}

const unitOf = (phase: ScanPhase, total: number) =>
  phase === 'deployments' ? (total === 1 ? 'source' : 'sources') : total === 1 ? 'repo' : 'repos'

/** "12 of 38 repos", or null when the phase has no units yet (or none at all). */
export function phaseCount(status: Pick<ScanningStatus, 'phase' | 'done' | 'total'>) {
  if (status.total === 0) return null
  return `${status.done.toLocaleString('en-US')} of ${status.total.toLocaleString('en-US')} ${unitOf(status.phase, status.total)}`
}

/** "Fetching open alerts, 12 of 38 repos" for the sidebar, top bar and settings. */
export function describeScanning(status: ScanningStatus): string {
  const count = phaseCount(status)
  return count ? `${PHASE_LABEL[status.phase]}, ${count}` : PHASE_LABEL[status.phase]
}
