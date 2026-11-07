import {
  RUNTIMES,
  SOURCE_KINDS,
  type Runtime,
  type RuntimePinRecord,
  type RuntimePinsDisagreeEvidence,
  type RuntimePinsEntry,
} from '@hinomi/shared'
import { productionPin } from '../../pins/index.js'
import type { RepoPins } from '../collect.js'
import {
  RUNTIME_LABELS,
  comparableLine,
  compareVersions,
  evidencePin,
  fixHintsFor,
  lineSatisfies,
  parseVersion,
  worstResult,
} from './runtime-lines.js'
import type { Guard, GuardSubjectResult } from './types.js'

// runtime_pins_disagree (docs/design/phase-2.md section 5.5): the non floating pins of one runtime
// in one repo name more than one line. Warn only (low). The exceptions:
// - CI may test several lines (a matrix, or several jobs) as long as one of them is the
//   production line; it disagrees only when no CI pin uses it.
// - An `engines` range disagrees only when a pinned line does not fit it.
// - A Dockerfile build stage may differ when it is a pure build stage; a stage the final image is
//   built on or copies `node_modules` from (`finalStage`) must match.
// - Floating pins, unreadable pins and minimums (Cargo `rust-version`) never count.

export interface PinsDisagreement {
  entry: RuntimePinsEntry
  /** The pins that disagree, as stored (the repo detail highlights them). */
  disagreeing: RuntimePinRecord[]
}

const isCi = (pin: RuntimePinRecord) => pin.scope === 'ci'

/** Pins that run the app or build what it runs: version files, deployed and other Dockerfiles. */
const isFixed = (pin: RuntimePinRecord) =>
  !isCi(pin) && pin.kind === 'exact' && (pin.source !== 'dockerfile' || pin.finalStage !== false)

/** The line most fixed pins name, the newest on a tie. */
function commonLine(lines: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let best: { line: string; count: number } | null = null
  for (const [line, count] of counts) {
    const newer =
      best !== null &&
      count === best.count &&
      compareVersions(parseVersion(line) ?? [0, 0, 0], parseVersion(best.line) ?? [0, 0, 0]) > 0
    if (best === null || count > best.count || newer) best = { line, count }
  }
  return best?.line ?? null
}

const fileName = (path: string) => path.split('/').pop() ?? path

function describePin(pin: RuntimePinRecord): string {
  return pin.source === 'dockerfile' ? `${pin.path} (${pin.raw})` : fileName(pin.path)
}

/** The rule for one runtime; null when the repo has no pin of it that could disagree. */
export function evaluateRuntimePins(
  pins: readonly RuntimePinRecord[],
  runtime: Runtime,
): PinsDisagreement | null {
  const own = pins.filter((p) => p.runtime === runtime && p.kind !== 'minimum')
  if (own.length === 0) return null
  const production = productionPin(own, runtime)
  const productionLine = production?.kind === 'exact' ? comparableLine(production) : null

  const fixed = own.filter((p) => isFixed(p) && comparableLine(p) !== null)
  const reference = productionLine ?? commonLine(fixed.map((p) => comparableLine(p)!))
  const disagreeing = new Set<RuntimePinRecord>()
  const notes: string[] = []

  // Fixed pins against the production line (or the line most of them name).
  if (reference !== null) {
    const off = fixed.filter((p) => comparableLine(p) !== reference)
    for (const pin of off) {
      disagreeing.add(pin)
      notes.push(`${describePin(pin)} says ${comparableLine(pin)}`)
    }
  }

  // CI: fine while one CI pin uses the reference line.
  const ci = own.filter((p) => isCi(p) && comparableLine(p) !== null)
  const ciLines = [...new Set(ci.map((p) => comparableLine(p)!))]
  if (reference !== null && ciLines.length > 0 && !ciLines.includes(reference)) {
    for (const pin of ci) disagreeing.add(pin)
    notes.push(`CI tests on ${ciLines.join(', ')} only`)
  }

  // Ranges: each fixed line (and the production line) must fit.
  const lines = [
    ...new Set([
      ...(productionLine ? [productionLine] : []),
      ...fixed.map((p) => comparableLine(p)!),
    ]),
  ]
  for (const range of own.filter((p) => !isCi(p) && p.kind === 'range' && p.version !== null)) {
    const outside = lines.filter((line) => !lineSatisfies(runtime, range.version!, line))
    if (outside.length === 0) continue
    disagreeing.add(range)
    notes.push(`${fileName(range.path)} ${range.raw} excludes ${outside.join(', ')}`)
  }

  const result = disagreeing.size > 0 ? 'warn' : 'pass'
  const label = RUNTIME_LABELS[runtime]
  const lead = productionLine
    ? `production runs ${productionLine}`
    : reference
      ? `most pins say ${reference}`
      : null
  const list = [...disagreeing]
  return {
    disagreeing: list,
    entry: {
      runtime,
      result,
      productionLine,
      pins: own.map(evidencePin),
      disagreeing: list.map(evidencePin),
      fixHints:
        result === 'warn' && reference !== null
          ? fixHintsFor(own, runtime, { line: reference, latest: null }, (p) => disagreeing.has(p))
          : [],
      reason:
        result === 'warn'
          ? `${label} pins disagree: ${[lead, ...notes].filter(Boolean).join(', ')}.`
          : null,
    },
  }
}

/** Every runtime of the repo, in `RUNTIMES` order. */
export function evaluatePinsDisagree(pins: readonly RuntimePinRecord[]): PinsDisagreement[] {
  return RUNTIMES.flatMap((runtime) => evaluateRuntimePins(pins, runtime) ?? [])
}

/** The finding of one repo; null leaves its row alone (its pins were never read). */
export function pinsDisagreeResult(
  repoId: number,
  repoPins: RepoPins | null | undefined,
): GuardSubjectResult | null {
  if (!repoPins) return null
  const runtimes = evaluatePinsDisagree(repoPins.pins).map((d) => d.entry)
  const evidence: RuntimePinsDisagreeEvidence = {
    check: 'runtime_pins_disagree',
    ref: repoPins.ref,
    runtimes,
    reason: repoPins.error
      ? `The pins could not be read this scan; these are the ones stored earlier (${repoPins.error}).`
      : null,
  }
  return { subject: { repoId }, level: worstResult(runtimes.map((r) => r.result)), evidence }
}

export const runtimePinsDisagreeGuard: Guard = {
  check: 'runtime_pins_disagree',
  capabilities: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 'full' as const])),
  run(ctx) {
    // Needs no support data: it compares the pins with each other.
    return ctx.repos.flatMap((repo) => {
      const result = pinsDisagreeResult(repo.id, ctx.scans.get(repo.id)?.pins)
      return result ? [result] : []
    })
  },
}
