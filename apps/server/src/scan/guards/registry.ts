import { sharedNetworkGuard } from './shared-network.js'
import type { Guard } from './types.js'

/**
 * Every check a scan runs, in order. A check is one file under scan/guards/ exporting a `Guard`;
 * register it by adding it here (see docs/guards.md). Tests pass their own list to `runScan`.
 */
export const GUARDS: readonly Guard[] = [sharedNetworkGuard]
