import type { Logger } from '../log.js'
import type { Repositories } from '../repository/index.js'
import type { Scheduler } from '../scheduler/index.js'
import type { SourceTesters } from './source-testers.js'

/** What the API routes need. Built once in index.ts, swapped for fakes in tests. */
export interface ApiDeps {
  repositories: Repositories
  scheduler: Scheduler
  testers: SourceTesters
  log: Logger
  now: () => Date
}
