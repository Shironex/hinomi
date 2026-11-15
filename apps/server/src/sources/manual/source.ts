import { MANUAL_CAPABILITIES, type DeploymentRecord } from '@hinomi/shared'
import type {
  DeploymentSource,
  DeploymentSourceConfig,
  DeploymentSourceFactory,
  StoredManualEntry,
} from '../deployments/types.js'

// A manual list behind the deployment source interface (docs/design/phase-2.md section 9.5).
// The entries are typed in (web form, API or YAML) and kept as deployments of the source; its
// inventory hands them back, so the scan treats them like any other source's. It reads nothing
// from a platform, so it needs no token and reports no run status: `unknown` ranks as running.

/** One stored entry as the normalised record every source returns. Container facts are left out: the stored ones stay. */
export function manualRecord(sourceName: string, entry: StoredManualEntry): DeploymentRecord {
  return {
    source: sourceName,
    externalId: entry.externalId,
    name: entry.name,
    kind: 'application',
    repo: entry.repo,
    branch: entry.branch,
    gitRepository: entry.repo,
    domains: entry.domains,
    isPublic: entry.reach === 'public',
    reach: entry.reach,
    server: entry.server,
    status: 'unknown',
    image: entry.image,
    lastDeployAt: null,
    watchPaths: null,
  }
}

function openManual(config: DeploymentSourceConfig): DeploymentSource {
  return {
    sourceId: config.sourceId,
    kind: 'manual',
    name: config.name,
    capabilities: MANUAL_CAPABILITIES,
    inventory: () =>
      Promise.resolve((config.manualEntries?.() ?? []).map((e) => manualRecord(config.name, e))),
  }
}

export const manualDeploymentSource: DeploymentSourceFactory = {
  kind: 'manual',
  capabilities: MANUAL_CAPABILITIES,
  needsToken: false,
  open: openManual,
}
