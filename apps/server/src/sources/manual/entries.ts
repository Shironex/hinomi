import type { DeploymentReach } from '@hinomi/shared'
import type { StoredManualEntry } from '../deployments/types.js'

/** The columns of a stored deployment that make up a manual entry. */
interface StoredRow {
  externalId: string
  name: string
  gitRepository: string | null
  gitBranch: string | null
  image: string | null
  domains: string[]
  reach: DeploymentReach
  server: string | null
}

/** The deployments stored for a manual source, as the entries its inventory hands back. */
export function manualEntriesOf(rows: readonly StoredRow[]): StoredManualEntry[] {
  return rows.map((row) => ({
    externalId: row.externalId,
    name: row.name,
    repo: row.gitRepository,
    branch: row.gitBranch,
    image: row.image,
    domains: row.domains,
    reach: row.reach,
    server: row.server,
  }))
}
