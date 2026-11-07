import type { SecretBox } from '../crypto/secret-box.js'
import type { Db } from '../db/client.js'
import { createAdvisoriesRepository } from './advisories.js'
import { createDeploymentsRepository } from './deployments.js'
import { createFindingsRepository } from './findings.js'
import { createFixRunsRepository } from './fix-runs.js'
import { createFixPlansRepository } from './plans.js'
import { createRepoSourcesRepository } from './repo-sources.js'
import { createReposRepository } from './repos.js'
import { createScanRunsRepository } from './scan-runs.js'
import { createSettingsRepository } from './settings.js'
import { createSourcesRepository } from './sources.js'

export type Repositories = ReturnType<typeof createRepositories>

/**
 * Typed data access for the whole app. All functions are synchronous
 * (better-sqlite3); wrap multi-step writes in `db.transaction(() => ...)`.
 *
 * @param secretBox null when HINOMI_SECRET_KEY is not set.
 */
export function createRepositories(db: Db, secretBox: SecretBox | null) {
  return {
    db,
    sources: createSourcesRepository(db, secretBox),
    repos: createReposRepository(db),
    repoSources: createRepoSourcesRepository(db),
    deployments: createDeploymentsRepository(db),
    advisories: createAdvisoriesRepository(db),
    findings: createFindingsRepository(db),
    scanRuns: createScanRunsRepository(db),
    fixPlans: createFixPlansRepository(db),
    fixRuns: createFixRunsRepository(db),
    settings: createSettingsRepository(db),
  }
}
