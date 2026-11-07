// Fix runners: hand a repo's fix plan to whatever applies it (GitHub Actions now) and check that
// a repo is set up for it (permissions, caller workflow pin).
export { inspectCallerWorkflow, readCaller, unknownCaller } from './caller.js'
export type { CallerInspection, LatestFixWorkflow, ReadCallerOptions } from './caller.js'
export { MAX_DECOMPRESSED_PLAN_BYTES, zlibCompressor } from './compressor.js'
export {
  GithubActionsRunner,
  callerWorkflowOf,
  dispatchFailureReason,
  dispatchInputs,
  type GithubActionsRunnerOptions,
} from './github-actions.js'
export { openRunnerGithub, type RunnerGithub, type RunnerGithubOptions } from './github.js'
export {
  RUNNER_APP_PERMISSIONS,
  appPermissions,
  classicTokenPermissions,
  fineGrainedPermissions,
  probeRunnerPermissions,
  type FineGrainedProbes,
  type ProbeTarget,
} from './permissions.js'
export type {
  FixRunDispatchCreated,
  FixRunDispatchOutcome,
  FixRunDispatchRefusal,
  FixRunDispatchRequest,
  FixRunner,
} from './runner.js'
export {
  createFixRunService,
  previousPrOf,
  type DispatchFixRunResult,
  type DispatchRefused,
  type FixRunService,
  type FixRunServiceOptions,
  type RunnerStatusView,
} from './service.js'
