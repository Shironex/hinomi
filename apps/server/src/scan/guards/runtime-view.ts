import type { RepoRuntimePin, RepoSupportLines, StoredRuntimePin } from '@hinomi/shared'
import type { SupportIndex } from '../../support/index.js'
import { evaluatePinsDisagree } from './runtime-pins-disagree.js'
import { evaluateRuntimeSupport, type RuntimeSupportOptions } from './runtime-support.js'

export interface RepoRuntimeView {
  runtimePins: RepoRuntimePin[]
  supportLines: RepoSupportLines
}

/**
 * The runtime panel of a repo (GET /api/repos/:id): its stored pins with the disagreeing ones
 * marked, and each runtime judged the way the runtime checks judge it, at request time.
 */
export function repoRuntimeView(
  pins: readonly StoredRuntimePin[],
  support: SupportIndex | null,
  options: RuntimeSupportOptions,
): RepoRuntimeView {
  const disagreeing = new Set(evaluatePinsDisagree(pins).flatMap((d) => d.disagreeing))
  return {
    runtimePins: pins.map((pin) => ({
      runtime: pin.runtime,
      source: pin.source,
      path: pin.path,
      line: pin.line,
      raw: pin.raw,
      lineName: pin.lineName,
      floating: pin.floating,
      kind: pin.kind,
      version: pin.version,
      scope: pin.scope,
      job: pin.job,
      stage: pin.stage,
      finalStage: pin.finalStage,
      ref: pin.ref,
      scannedAt: pin.scannedAt.toISOString(),
      disagrees: disagreeing.has(pin),
    })),
    supportLines: {
      available: support !== null,
      runtimes: support === null ? [] : evaluateRuntimeSupport(pins, support, options),
    },
  }
}
