import type { Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import type { FixRunService, FixRunTracker } from '../runner/index.js'
import type { Scheduler } from '../scheduler/index.js'
import type { UpdateChecker } from '../version/index.js'
import type { SourceTesters } from './source-testers.js'

/** What the API routes need. Built once in index.ts, swapped for fakes in tests. */
export interface ApiDeps {
  repositories: Repositories
  scheduler: Scheduler
  testers: SourceTesters
  log: Logger
  now: () => Date
  /** Fetch for live reads from a source (deploy history). Replaced in tests. */
  sourceFetch?: typeof fetch
  /** Runner settings, status and dispatch of fix runs. */
  fixRuns: FixRunService
  /** The update check; absent when none runs (tests). */
  updates?: Pick<UpdateChecker, 'check'>
  /** Tracking state of fix runs; absent when no tracker runs (tests). */
  fixRunTracking?: Pick<FixRunTracker, 'status'>
}
