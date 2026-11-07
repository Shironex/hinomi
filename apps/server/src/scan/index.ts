// Scan pipeline: joins Coolify, GitHub and OSV into ranked findings and blind spots.
export { runRepoScan, runScan, skippedPhases } from './run.js'
export type {
  RepoScanSummary,
  RunScanOptions,
  ScanError,
  ScanLogger,
  ScanProgress,
  ScanSummary,
} from './run.js'
export { errorMessage } from './collect.js'
export { isImageOnly, needsRepoMapping } from './deployments.js'
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
  GUARD_SEVERITY,
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
  type GuardCounts,
} from './counts.js'
export {
  GUARDS,
  applyGuards,
  evaluateGuards,
  runGuards,
  toOutcomes,
  type Guard,
  type GuardContext,
  type GuardOutcome,
  type GuardSubject,
  type GuardSubjectResult,
} from './guards/index.js'
export {
  applyOverridesNow,
  indexOverrides,
  isTurnedOff,
  loadOverrideIndex,
  type CoveringOverride,
  type OverrideIndex,
} from './overrides.js'
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
export {
  fixOf,
  groupFixes,
  isFixable,
  type Fix,
  type FixableFinding,
  type FixFilter,
  type FixRepoGroup,
} from './fixes.js'
export {
  buildFixPlan,
  bumpLevel,
  comparePlan,
  packageManagerOf,
  saveScanPlans,
  toRepoRef,
  type BuildFixPlanInput,
  type RepoLockfiles,
} from './plans.js'
