import {
  RUNTIMES,
  RUNTIME_PRODUCTS,
  RUNTIME_SUPPORT_RULE,
  SOURCE_KINDS,
  type GuardResult,
  type RuntimePinRecord,
  type RuntimeSupportEntry,
  type RuntimeSupportEvidence,
  type SupportTarget,
} from '@hinomi/shared'
import { productionPin } from '../../pins/index.js'
import {
  isPastEol,
  windowStateOf,
  type SupportIndex,
  type SupportProduct,
  type SupportRelease,
} from '../../support/index.js'
import type { RepoPins } from '../collect.js'
import {
  RUNTIME_LABELS,
  compareVersions,
  evidencePin,
  fixHintsFor,
  isBunMajorOnly,
  newestVersion,
  parseVersion,
  supportLineOf,
  worstResult,
} from './runtime-lines.js'
import type { Guard, GuardSubjectResult } from './types.js'

// runtime_support (docs/design/phase-2.md sections 5.4 and 5.6, decision Q12a): what a repo runs
// in production, by the pin precedence of `productionPin`, judged per runtime.
// - Node: the line's end of security support from endoflife.date. Past it fails, inside the
//   warning window warns, otherwise passes.
// - Rust and Bun: endoflife.date has no usable end dates for them, so a pinned version warns once
//   it is more than N releases behind the latest (a setting per runtime). Never fails.
// A floating pin (`lts`, `stable`, `latest`, `rust:1`, `bun@1`) passes and says what it is today.
// CI pins and Cargo `rust-version` (a minimum) never decide it.

export interface RuntimeSupportOptions {
  now: Date
  /** Days before end of support at which a Node line warns. */
  windowDays: number
  /** Releases a Rust or Bun pin may be behind the latest before it warns. */
  behindReleases: { rust: number; bun: number }
}

/** Node: the newest line still in LTS and not ending soon, else the newest line not past end of life. */
function nodeTarget(product: SupportProduct, options: RuntimeSupportOptions): SupportTarget | null {
  const healthy = (release: SupportRelease) => {
    const state = windowStateOf(release, options.now, options.windowDays)
    return state === 'supported' || state === 'maintenance'
  }
  const target =
    product.releases.find((r) => r.isLts && healthy(r)) ?? product.releases.find(healthy) ?? null
  return target && { line: target.name, latest: target.latest?.name ?? null }
}

/** The line a floating Node pin follows today: `lts` the newest live LTS line, else the newest live line. */
function floatingNodeLine(
  product: SupportProduct,
  channel: string | null,
  now: Date,
): SupportRelease | null {
  const live = product.releases.filter((r) => !isPastEol(r, now))
  const lts = channel === 'lts' || (channel?.startsWith('lts') ?? false)
  return (lts ? live.find((r) => r.isLts) : undefined) ?? live[0] ?? null
}

/** Rust and Bun: the latest release, as the line it starts and the full version. */
function latestTarget(product: SupportProduct): SupportTarget | null {
  const latest = newestVersion(product)
  const version = parseVersion(latest)
  if (latest === null || version === null) return null
  return { line: `${version[0]}.${version[1]}`, latest }
}

type Base = Pick<RuntimeSupportEntry, 'runtime' | 'pin' | 'rule'>

function entry(
  base: Base,
  result: GuardResult,
  rest: Partial<Omit<RuntimeSupportEntry, keyof Base | 'result'>> = {},
): RuntimeSupportEntry {
  return {
    ...base,
    result,
    support: null,
    resolvedTo: null,
    target: null,
    fixHints: [],
    latest: null,
    releasesBehind: null,
    maxBehind: null,
    reason: null,
    ...rest,
  }
}

function nodeEntry(
  base: Base,
  pin: RuntimePinRecord,
  pins: readonly RuntimePinRecord[],
  product: SupportProduct,
  support: SupportIndex,
  options: RuntimeSupportOptions,
): RuntimeSupportEntry {
  const target = nodeTarget(product, options)
  const latest = newestVersion(product)
  if (pin.kind === 'floating') {
    const line = floatingNodeLine(product, pin.version, options.now)
    return entry(base, 'pass', {
      support: line && supportLineOf(product, line, options.now),
      resolvedTo: line?.name ?? null,
      target,
      latest,
      reason: line
        ? `${pin.raw} follows the newest ${pin.version === 'lts' ? 'LTS ' : ''}line by itself: ${line.name} today.`
        : `${pin.raw} follows the newest line by itself.`,
    })
  }
  if (pin.kind === 'unknown' || pin.lineName === null) {
    return entry(base, 'unknown', {
      target,
      latest,
      reason: `${pin.raw} in ${pin.path} names no version Hinomi can read (a variable or a digest).`,
    })
  }
  const release = support.line(product.name, pin.lineName)
  if (release === null) {
    return entry(base, 'unknown', {
      target,
      latest,
      reason: `Node ${pin.lineName} is not in the support data yet (a typo, or a line newer than the cached copy).`,
    })
  }
  const state = windowStateOf(release, options.now, options.windowDays)
  const result: GuardResult = state === 'eol' ? 'fail' : state === 'ending' ? 'warn' : 'pass'
  return entry(base, result, {
    support: supportLineOf(product, release, options.now),
    target,
    latest,
    fixHints: result === 'pass' ? [] : fixHintsFor(pins, 'node', target),
  })
}

function behindEntry(
  base: Base,
  runtime: 'rust' | 'bun',
  pin: RuntimePinRecord,
  pins: readonly RuntimePinRecord[],
  product: SupportProduct,
  maxBehind: number,
): RuntimeSupportEntry {
  const target = latestTarget(product)
  const latest = target?.latest ?? null
  const common = { target, latest, maxBehind }
  const label = RUNTIME_LABELS[runtime]
  if (pin.kind === 'floating' || isBunMajorOnly(pin)) {
    return entry(base, 'pass', {
      ...common,
      resolvedTo: target?.line ?? null,
      reason: `${pin.raw} follows the latest ${label} release by itself${latest ? `: ${latest} today` : ''}.`,
    })
  }
  if (pin.kind === 'range') {
    return entry(base, 'pass', {
      ...common,
      reason: `${pin.raw} is a range, not a pinned version, so it takes new releases.`,
    })
  }
  const pinned = parseVersion(pin.version)
  if (pin.kind === 'unknown' || pinned === null) {
    return entry(base, 'unknown', {
      ...common,
      reason: `${pin.raw} in ${pin.path} names no version Hinomi can read (a variable or a digest).`,
    })
  }
  const newest = parseVersion(latest)
  if (newest === null) {
    return entry(base, 'unknown', {
      ...common,
      reason: `The support data names no latest ${label} release yet.`,
    })
  }
  if (compareVersions([pinned[0], pinned[1], 0], [newest[0], newest[1], 0]) > 0) {
    return entry(base, 'unknown', {
      ...common,
      reason: `${label} ${pinned[0]}.${pinned[1]} is newer than the support data (latest ${latest}); the next refresh will know it.`,
    })
  }
  const behind = pinned[0] === newest[0] ? newest[1] - pinned[1] : null
  const result: GuardResult = behind === null || behind > maxBehind ? 'warn' : 'pass'
  const releases = runtime === 'rust' ? 'stable releases' : 'minor releases'
  return entry(base, result, {
    ...common,
    releasesBehind: behind,
    fixHints: result === 'pass' ? [] : fixHintsFor(pins, runtime, target),
    reason:
      behind === null
        ? `${label} ${pinned[0]}.${pinned[1]} is a major release behind the latest (${latest}).`
        : `${label} ${pinned[0]}.${pinned[1]} is ${behind} ${releases} behind the latest (${latest}); it warns past ${maxBehind}.`,
  })
}

/**
 * One entry per runtime the repo runs in production (in `RUNTIMES` order). A runtime pinned only
 * in CI or only by a minimum gets no entry.
 */
export function evaluateRuntimeSupport(
  pins: readonly RuntimePinRecord[],
  support: SupportIndex,
  options: RuntimeSupportOptions,
): RuntimeSupportEntry[] {
  const entries: RuntimeSupportEntry[] = []
  for (const runtime of RUNTIMES) {
    const pin = productionPin(pins, runtime)
    if (pin === null) continue
    const rule = RUNTIME_SUPPORT_RULE[runtime]
    const base: Base = { runtime, pin: evidencePin(pin), rule }
    const product = support.product(RUNTIME_PRODUCTS[runtime])
    if (product === null) {
      entries.push(
        entry(base, 'unknown', {
          reason: `The support data has no ${RUNTIME_PRODUCTS[runtime]} product.`,
        }),
      )
      continue
    }
    entries.push(
      runtime === 'node'
        ? nodeEntry(base, pin, pins, product, support, options)
        : behindEntry(base, runtime, pin, pins, product, options.behindReleases[runtime]),
    )
  }
  return entries
}

/** The finding of one repo; null leaves its row alone (its pins were never read). */
export function runtimeSupportResult(
  repoId: number,
  repoPins: RepoPins | null | undefined,
  support: SupportIndex,
  options: RuntimeSupportOptions,
): GuardSubjectResult | null {
  if (!repoPins) return null
  const runtimes = evaluateRuntimeSupport(repoPins.pins, support, options)
  const evidence: RuntimeSupportEvidence = {
    check: 'runtime_support',
    ref: repoPins.ref,
    runtimes,
    reason: repoPins.error
      ? `The pins could not be read this scan; these are the ones stored earlier (${repoPins.error}).`
      : null,
  }
  return { subject: { repoId }, level: worstResult(runtimes.map((r) => r.result)), evidence }
}

export const runtimeSupportGuard: Guard = {
  check: 'runtime_support',
  // Pins come from the repo's files, whatever source deploys it.
  capabilities: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 'full' as const])),
  run(ctx) {
    const support = ctx.support
    // No support data yet (fresh install, no network): leave every row as it is.
    if (support === null) return []
    const options = {
      now: ctx.now,
      windowDays: ctx.supportWindowDays,
      behindReleases: ctx.behindReleases,
    }
    return ctx.repos.flatMap((repo) => {
      const result = runtimeSupportResult(repo.id, ctx.scans.get(repo.id)?.pins, support, options)
      return result ? [result] : []
    })
  },
}
