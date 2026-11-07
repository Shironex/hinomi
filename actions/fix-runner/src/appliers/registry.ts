import { cargoApplier } from './cargo.js'
import { npmApplier } from './npm.js'
import { pnpmApplier } from './pnpm.js'
import type { Applier, StepPackageManager } from './types.js'

/**
 * The appliers this build ships. yarn and bun join here (62.6); a step for a package
 * manager without an applier fails with a clear detail instead of being guessed at.
 */
export const APPLIERS: ReadonlyMap<StepPackageManager, Applier> = new Map<
  StepPackageManager,
  Applier
>([
  ['pnpm', pnpmApplier],
  ['npm', npmApplier],
  ['cargo', cargoApplier],
])
