import type { FixReleaseAgeCheck } from '@hinomi/shared'

// The release age gate: a target version must be public for a while before the runner
// applies it. The gate applied is the stricter of Hinomi's floor (the dispatch's
// releaseAgeDays) and the repo's own setting. The runner never lowers a gate and never adds
// an exclusion; an exclusion the repo already has only lifts the repo's gate, never Hinomi's.

const MINUTE = 60_000
const MINUTES_PER_DAY = 1_440

export interface RepoGate {
  /** Minimum age in minutes. */
  minutes: number
  /** Where it was read, e.g. `pnpm-workspace.yaml minimumReleaseAge`. */
  source: string
  /** Names (`@scope/*` patterns too) or `name@version` entries the repo exempts. */
  exclude: string[]
}

function excluded(gate: RepoGate, packageName: string, version: string): boolean {
  return gate.exclude.some((entry) => {
    const at = entry.lastIndexOf('@')
    if (at > 0) {
      return entry.slice(0, at) === packageName && entry.slice(at + 1) === version
    }
    const pattern = new RegExp(
      `^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    )
    return pattern.test(packageName)
  })
}

export interface EffectiveGate {
  minutes: number
  days: number
  source: string
}

/** The stricter of Hinomi's floor and the repo's gate for one package version. */
export function effectiveGate(
  floorDays: number,
  repoGate: RepoGate | null,
  packageName: string,
  version: string,
): EffectiveGate {
  const floor = floorDays * MINUTES_PER_DAY
  const repo = repoGate && !excluded(repoGate, packageName, version) ? repoGate.minutes : 0
  const minutes = Math.max(floor, repo)
  const source = repo > floor ? (repoGate?.source ?? 'repo') : 'hinomi'
  return { minutes, days: Math.ceil(minutes / MINUTES_PER_DAY), source }
}

/** Checks one target against the gate, as the result file records it. */
export function checkReleaseAge(input: {
  stepId: string
  packageName: string
  version: string
  publishedAt: Date | null
  gate: EffectiveGate
  now: Date
}): FixReleaseAgeCheck {
  const { publishedAt, gate, now } = input
  const base = {
    stepId: input.stepId,
    packageName: input.packageName,
    version: input.version,
    gateDays: gate.days,
    gateSource: gate.source,
  }
  if (!publishedAt) return { ...base, publishedAt: null, status: 'unknown', eligibleAt: null }
  const eligible = new Date(publishedAt.getTime() + gate.minutes * MINUTE)
  return {
    ...base,
    publishedAt: publishedAt.toISOString(),
    status: eligible.getTime() <= now.getTime() ? 'clear' : 'too_new',
    eligibleAt: eligible.getTime() <= now.getTime() ? null : eligible.toISOString(),
  }
}

/** Minutes of a `before` cut off date relative to now (npm's absolute form of the gate). */
export function minutesSince(date: Date, now: Date): number {
  return Math.max(0, Math.ceil((now.getTime() - date.getTime()) / MINUTE))
}

export { MINUTES_PER_DAY }
