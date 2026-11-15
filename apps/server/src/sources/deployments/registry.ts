import { isDeploymentSourceKind, type DeploymentSourceKind, type SourceKind } from '@hinomi/shared'
import { coolifyDeploymentSource } from '../coolify/source.js'
import { manualDeploymentSource } from '../manual/source.js'
import { dokployDeploymentSource } from '../dokploy/source.js'
import { dockerDeploymentSource } from '../docker/source.js'
import type {
  CachedFacts,
  DeploymentSource,
  DeploymentSourceConfig,
  DeploymentSourceFactory,
  StoredManualEntry,
} from './types.js'

/** Every kind of deployment source. A new source adds its factory here. */
export const DEPLOYMENT_SOURCES: Record<DeploymentSourceKind, DeploymentSourceFactory> = {
  coolify: coolifyDeploymentSource,
  manual: manualDeploymentSource,
  dokploy: dokployDeploymentSource,
  docker: dockerDeploymentSource,
}

/** The fields of a `sources` row that opening a deployment source reads. */
export interface DeploymentSourceRow {
  id: number
  kind: SourceKind
  name: string
  baseUrl: string | null
  /** Kind specific settings (`sources.config`); absent or null when none. */
  config?: Record<string, unknown> | null
}

/** Where the credential and the stored facts of a source come from (the repositories). */
export interface DeploymentSourceStore {
  /** The decrypted token, null when none is stored; throws when it cannot be decrypted. */
  getToken(sourceId: number): string | null
  /** Facts stored for the source's deployments, by external id. */
  cachedFacts?(sourceId: number): ReadonlyMap<string, CachedFacts>
  /** The entries of a manual list. */
  manualEntries?(sourceId: number): StoredManualEntry[]
}

/**
 * True when a scan reads this stored source: a deployment source kind, switched on, and holding
 * a token when its kind needs one.
 */
export function isScannedDeploymentSource(
  row: Pick<DeploymentSourceRow, 'kind'> & { enabled: boolean; hasToken: boolean },
): boolean {
  if (!isDeploymentSourceKind(row.kind) || !row.enabled) return false
  return row.hasToken || !DEPLOYMENT_SOURCES[row.kind].needsToken
}

/** False for a source that connects with no token: OSV.dev and the deployment sources that need none. */
export function sourceNeedsToken(kind: SourceKind): boolean {
  if (kind === 'osv') return false
  return !isDeploymentSourceKind(kind) || DEPLOYMENT_SOURCES[kind].needsToken
}

export type OpenDeploymentSourceOptions = Pick<DeploymentSourceConfig, 'timeoutMs' | 'fetch'>

/**
 * Binds a stored source to its kind's implementation, or null when the row is not a deployment
 * source. The token is read once, on first use; a token that is missing or cannot be decrypted
 * fails that use with a message that never holds the token.
 */
export function openDeploymentSource(
  row: DeploymentSourceRow,
  store: DeploymentSourceStore,
  options: OpenDeploymentSourceOptions = {},
): DeploymentSource | null {
  if (!isDeploymentSourceKind(row.kind)) return null
  let token: string | null | undefined
  const readToken = (): string => {
    if (token === undefined) {
      try {
        token = store.getToken(row.id)
      } catch {
        throw new Error(`The token of "${row.name}" cannot be read. Check HINOMI_SECRET_KEY.`)
      }
    }
    if (!token) throw new Error(`The source "${row.name}" has no token.`)
    return token
  }
  return DEPLOYMENT_SOURCES[row.kind].open({
    sourceId: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    config: row.config ?? null,
    token: readToken,
    ...(store.cachedFacts && { cachedFacts: () => store.cachedFacts!(row.id) }),
    ...(store.manualEntries && { manualEntries: () => store.manualEntries!(row.id) }),
    ...options,
  })
}
