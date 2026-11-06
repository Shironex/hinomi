// Scan pipeline: joins Coolify, GitHub and OSV into ranked findings and blind spots.
export { runScan, skippedPhases } from './run.js'
export type { RunScanOptions, ScanError, ScanLogger, ScanProgress, ScanSummary } from './run.js'
export { buildScanSources } from './sources.js'
export type {
  BuildScanSourcesOptions,
  CoolifyScanSource,
  GithubScanSource,
  OsvScanSource,
  ScanSources,
} from './sources.js'
export type { FindingChange } from './apply.js'
export {
  DEFAULT_SCAN_SETTINGS,
  readScanSettings,
  SCAN_SETTING_KEYS,
  type ScanSettings,
} from './settings.js'
export {
  BLIND_SPOT_SEVERITY,
  allStopped,
  compareByRank,
  isStoppedStatus,
  rankExposure,
  reachOf,
  tierOf,
  type ExposureFactors,
  type ExposureInput,
  type ExposureRank,
  type ExposureReach,
} from './rank.js'
export {
  countFindings,
  funnelSteps,
  isDeferred,
  isExposed,
  type AdvisoryFunnel,
  type BlindSpotCounts,
  type CountableFinding,
  type FindingCounts,
} from './counts.js'
export {
  acceptFinding,
  canUserTransition,
  expireDeferred,
  expireForNewAdvisory,
  FindingTransitionError,
  reopenFinding,
  snoozeFinding,
  type Actor,
  type DeferInput,
  type FindingEventType,
  type UpstreamDismissal,
} from './state.js'
export {
  findingChangesSince,
  findingCounts,
  listRankedFindings,
  rankFinding,
  type FindingChangeSet,
  type RankedFinding,
} from './views.js'
export { groupFixes, isFixable, type Fix, type FixFilter, type FixRepoGroup } from './fixes.js'
