import type {
  FixHint,
  GuardResult,
  RepoRuntimePin,
  Runtime,
  RuntimeSupportEntry,
} from '@hinomi/shared'
import { RUNTIMES } from '@hinomi/shared'
import { plural } from './format'
import { fileAt, RUNTIME_LABEL, supportDate } from './guard-meta'

/** Where a pin applies, in the words of the panel. */
export const PIN_SCOPE_LABEL: Record<RepoRuntimePin['scope'], string> = {
  production: 'Production',
  ci: 'CI',
  dev: 'Development',
}

/** What the panel says about a pin beyond its value, or null when the value says it all. */
export function pinNote(pin: RepoRuntimePin): string | null {
  switch (pin.kind) {
    case 'floating':
      return pin.lineName
        ? `Floating, resolves to ${pin.lineName} today. Never compared.`
        : 'Floating, follows the latest by itself. Never compared.'
    case 'minimum':
      return 'A minimum, not the version that runs. Never judged.'
    case 'range':
      return pin.lineName ? `A range, the floor is ${pin.lineName}.` : 'A range.'
    case 'unknown':
      return 'No version Hinomi can read (a variable or a digest).'
    case 'exact':
      return null
  }
}

/** Pins grouped by runtime in the order of `RUNTIMES`, runtimes without a pin left out. */
export function pinsByRuntime(
  pins: readonly RepoRuntimePin[],
): { runtime: Runtime; pins: RepoRuntimePin[] }[] {
  return RUNTIMES.map((runtime) => ({
    runtime,
    pins: pins.filter((p) => p.runtime === runtime),
  })).filter((group) => group.pins.length > 0)
}

/**
 * How a runtime is judged, so Rust and Bun are never read as if they had an end of life date
 * (decision Q12a): they warn once the pin is too far behind the latest release and never fail.
 */
export function ruleNote(entry: Pick<RuntimeSupportEntry, 'runtime' | 'rule'>): string {
  if (entry.rule === 'support_window') {
    return 'Judged by the end of security support, from endoflife.date.'
  }
  const why =
    entry.runtime === 'rust'
      ? 'Rust supports only the newest stable release'
      : 'Bun publishes no end of life dates'
  return `${why}, so it is judged by releases behind the latest. It warns, it never fails.`
}

/** The one line a support entry stands for: "Node 22 ends 30 Apr 2027 (in 176 days)". */
export function supportHeadline(entry: RuntimeSupportEntry): string {
  const label = RUNTIME_LABEL[entry.runtime]
  if (entry.rule === 'support_window') {
    if (entry.support) return `${label} ${entry.support.line} ${supportDate(entry.support)}`
    return entry.reason ?? `${label} has no support line`
  }
  const pinned = [label, entry.pin?.lineName ?? entry.pin?.raw].filter(Boolean).join(' ')
  if (entry.releasesBehind === null) return entry.reason ?? pinned
  const releases = entry.runtime === 'rust' ? 'stable release' : 'minor release'
  const behind =
    entry.releasesBehind === 0
      ? 'on the latest line'
      : `${plural(entry.releasesBehind, releases)} behind`
  return `${pinned} is ${behind}${entry.latest ? ` (latest ${entry.latest})` : ''}`
}

/** The allowance of a "behind latest" entry: "Warns past 4 releases." Null for other rules. */
export function behindAllowance(entry: RuntimeSupportEntry): string | null {
  if (entry.rule !== 'behind_latest' || entry.maxBehind === null) return null
  return `Warns past ${plural(entry.maxBehind, 'release')}.`
}

/** A fix hint as one line: "Dockerfile:1  node:18-alpine -> node:24-alpine". */
export function hintText(hint: FixHint): string {
  return `${fileAt(hint.path, hint.line)}  ${hint.from} -> ${hint.to}`
}

/** The state of a dated support line in the overview strip. */
export const WINDOW_STATE_LABEL: Record<GuardResult, string> = {
  fail: 'Ended',
  warn: 'Ending soon',
  pass: 'Supported',
  unknown: 'Unknown',
}

/** "ended 554 days ago", "in 176 days", "today". */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft === 0) return 'today'
  return daysLeft < 0 ? `${plural(-daysLeft, 'day')} ago` : `in ${plural(daysLeft, 'day')}`
}
