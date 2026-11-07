import { bunApplier } from './bun.js'
import { cargoApplier } from './cargo.js'
import { npmApplier } from './npm.js'
import { pnpmApplier } from './pnpm.js'
import type { Applier, StepPackageManager } from './types.js'
import { yarnApplier } from './yarn.js'

/**
 * The appliers this build ships; a step for a package manager without an applier fails with
 * a clear detail instead of being guessed at.
 */
export const APPLIERS: ReadonlyMap<StepPackageManager, Applier> = new Map<
  StepPackageManager,
  Applier
>([
  ['pnpm', pnpmApplier],
  ['npm', npmApplier],
  ['yarn', yarnApplier],
  ['bun', bunApplier],
  ['cargo', cargoApplier],
])
