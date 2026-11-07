import type { PinKind, PinScope, Runtime, RuntimePinRecord, RuntimePinSource } from '@hinomi/shared'
import type { PinValue } from './value.js'

export interface PinSite {
  runtime: Runtime
  source: RuntimePinSource
  path: string
  line: number | null
  /** The value as written. */
  raw: string
  scope: PinScope
  job?: string
  stage?: number
  finalStage?: boolean
}

/** Joins where a pin was found with what it says. `kind` overrides the value's own (`minimum`). */
export function makePin(
  site: PinSite,
  value: PinValue,
  kind: PinKind = value.kind,
): RuntimePinRecord {
  return {
    runtime: site.runtime,
    source: site.source,
    path: site.path,
    line: site.line,
    raw: site.raw,
    lineName: value.lineName,
    floating: kind === 'floating',
    kind,
    version: value.version,
    scope: site.scope,
    job: site.job ?? null,
    stage: site.stage ?? null,
    finalStage: site.finalStage ?? null,
  }
}

/** Runtime names as tool managers write them (`nodejs` in asdf and mise). */
export function runtimeOfToolName(name: string): Runtime | null {
  switch (name.toLowerCase()) {
    case 'node':
    case 'nodejs':
      return 'node'
    case 'bun':
      return 'bun'
    case 'rust':
      return 'rust'
    default:
      return null
  }
}

export const lowerBasename = (path: string): string => (path.split('/').pop() ?? path).toLowerCase()
