import type {
  FixHint,
  GuardResult,
  Runtime,
  RuntimePin,
  RuntimePinRecord,
  SupportLine,
  SupportTarget,
} from '@hinomi/shared'
import {
  daysUntilEol,
  isPastEol,
  supportBasisOf,
  type SupportProduct,
  type SupportRelease,
} from '../../support/index.js'

// Shared by the runtime checks (docs/design/phase-2.md section 5): version arithmetic on pins,
// whether a release line fits an `engines` range, and the fix hints that move a pin to a line.
// Pin values come from scanned files: everything here matches patterns, nothing indexes by them.

/** Worst last. `unknown` sits below `warn`, as in the guard framework. */
export const RESULT_ORDER: Record<GuardResult, number> = { pass: 0, unknown: 1, warn: 2, fail: 3 }

export function worstResult(results: readonly GuardResult[]): GuardResult {
  return results.reduce<GuardResult>(
    (worst, result) => (RESULT_ORDER[result] > RESULT_ORDER[worst] ? result : worst),
    'pass',
  )
}

export const RUNTIME_LABELS: Record<Runtime, string> = { node: 'Node', bun: 'Bun', rust: 'Rust' }

export type Version = [number, number, number]

const VERSION = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?/

/** `1.80.0`, `1.80`, `22` (missing parts are 0); null when the text starts with no number. */
export function parseVersion(text: string | null): Version | null {
  const match = text === null ? null : VERSION.exec(text.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** How many dotted parts the text gives (`22` 1, `22.11` 2, `22.11.0` 3), 0 for none. */
export function versionPrecision(text: string | null): number {
  const match = text === null ? null : VERSION.exec(text.trim())
  if (!match) return 0
  return match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The newest version a product's data names: each line's latest release, else the line itself. */
export function newestVersion(product: SupportProduct): string | null {
  let best: { text: string; version: Version } | null = null
  for (const release of product.releases) {
    for (const text of [release.latest?.name ?? null, release.name]) {
      const version = parseVersion(text)
      if (text === null || version === null) continue
      if (best === null || compareVersions(version, best.version) > 0) best = { text, version }
    }
  }
  return best?.text ?? null
}

/** Whether active support of the line is over (bug fixes stopped, security fixes continue). */
function activeSupportOver(release: SupportRelease, now: Date): boolean | null {
  if (release.eoasFrom !== null) return now.getTime() >= Date.parse(`${release.eoasFrom}T00:00:00Z`)
  return release.isEoas
}

/** A release line as evidence carries it. */
export function supportLineOf(
  product: SupportProduct,
  release: SupportRelease,
  now: Date,
): SupportLine {
  return {
    product: product.name,
    line: release.name,
    eolFrom: release.eolFrom,
    isEol: isPastEol(release, now),
    isEoas: activeSupportOver(release, now),
    latest: release.latest?.name ?? null,
    basis: supportBasisOf(product),
    daysLeft: daysUntilEol(release, now),
  }
}

/** The part of a stored pin that evidence carries. */
export function evidencePin(pin: RuntimePinRecord): RuntimePin {
  return {
    runtime: pin.runtime,
    source: pin.source,
    path: pin.path,
    line: pin.line,
    raw: pin.raw,
    lineName: pin.lineName,
    floating: pin.floating,
  }
}

/**
 * The line two pins are compared on: the Node major, the Rust `major.minor`, and for Bun the
 * `major.minor` of the version (endoflife.date has a single Bun line, `1`, which tells nothing
 * apart). Null when the pin names no line: floating, unknown, a minimum, or a Bun `1` that means
 * the newest 1.x.
 */
export function comparableLine(pin: RuntimePinRecord): string | null {
  if (pin.kind === 'floating' || pin.kind === 'unknown' || pin.kind === 'minimum') return null
  if (pin.runtime !== 'bun' || pin.kind === 'range') return pin.lineName
  if (versionPrecision(pin.version) < 2) return null
  const version = parseVersion(pin.version)
  return version === null ? null : `${version[0]}.${version[1]}`
}

/** True when a Bun pin names only a major (`bun@1`): it follows the newest 1.x like a channel. */
export function isBunMajorOnly(pin: RuntimePinRecord): boolean {
  return pin.runtime === 'bun' && pin.kind === 'exact' && versionPrecision(pin.version) < 2
}

// ---------------------------------------------------------------------------
// Ranges

interface Bound {
  version: Version
  inclusive: boolean
}

interface Interval {
  low: Bound | null
  high: Bound | null
}

const PARTIAL =
  /^v?(\d{1,9}|[xX*])(?:\.(\d{1,9}|[xX*]))?(?:\.(\d{1,9}|[xX*]))?(?:[-+][0-9A-Za-z.+-]*)?$/

/** A partial version: the numbers given, up to the first wildcard or missing part. */
function partial(text: string): number[] | null {
  const match = PARTIAL.exec(text)
  if (!match) return null
  const parts: number[] = []
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || !/^\d+$/.test(part)) break
    parts.push(Number(part))
  }
  return parts
}

const padded = (parts: number[]): Version => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]

/** The first version past every version the partial covers (`1.2` gives `1.3.0`). */
function pastPartial(parts: number[]): Version | null {
  if (parts.length === 0) return null
  const next = [...parts]
  next[next.length - 1]! += 1
  return padded(next)
}

/** One comparator (`>=20`, `^22.1`, `~1.80`, `20.x`, `22`) as an interval; null when unreadable. */
function comparatorInterval(token: string): Interval | null {
  const match = /^(>=|<=|>|<|=|\^|~>|~)?\s*(.+)$/.exec(token)
  if (!match) return null
  const op = match[1] ?? ''
  const parts = partial(match[2]!)
  if (parts === null) return null
  const low = padded(parts)
  switch (op) {
    case '>=':
      return { low: { version: low, inclusive: true }, high: null }
    case '>': {
      const past = pastPartial(parts)
      return past
        ? { low: { version: past, inclusive: true }, high: null }
        : { low: null, high: null }
    }
    case '<':
      return parts.length === 0 ? null : { low: null, high: { version: low, inclusive: false } }
    case '<=': {
      const past = pastPartial(parts)
      return past
        ? { low: null, high: { version: past, inclusive: false } }
        : { low: null, high: null }
    }
    case '^': {
      // Up to the next change of the first non zero part.
      const keep = parts.findIndex((n) => n !== 0)
      const upto = keep === -1 ? parts.length : keep + 1
      const past = pastPartial(parts.slice(0, Math.max(1, Math.min(upto, parts.length))))
      return {
        low: { version: low, inclusive: true },
        high: past ? { version: past, inclusive: false } : null,
      }
    }
    case '~':
    case '~>': {
      // `~1.2.3` and `~1.2` stop before 1.3.0, `~1` before 2.0.0.
      const past = pastPartial(parts.slice(0, 2))
      return {
        low: { version: low, inclusive: true },
        high: past ? { version: past, inclusive: false } : null,
      }
    }
    default: {
      const past = pastPartial(parts)
      return {
        low: parts.length === 0 ? null : { version: low, inclusive: true },
        high: past ? { version: past, inclusive: false } : null,
      }
    }
  }
}

function intersect(a: Interval, b: Interval): Interval {
  const low =
    a.low === null
      ? b.low
      : b.low === null
        ? a.low
        : compareVersions(a.low.version, b.low.version) >= 0
          ? a.low
          : b.low
  const high =
    a.high === null
      ? b.high
      : b.high === null
        ? a.high
        : compareVersions(a.high.version, b.high.version) <= 0
          ? a.high
          : b.high
  return { low, high }
}

function isEmpty(interval: Interval): boolean {
  if (interval.low === null || interval.high === null) return false
  const cmp = compareVersions(interval.low.version, interval.high.version)
  return cmp > 0 || (cmp === 0 && !(interval.low.inclusive && interval.high.inclusive))
}

/** One `||` alternative as an interval; null when a part of it cannot be read. */
function alternativeInterval(text: string): Interval | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  const tokens = hyphen
    ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
    : text
        .replace(/(>=|<=|>|<|=|\^|~>|~)\s+/g, '$1')
        .split(/[\s,]+/)
        .filter(Boolean)
  let interval: Interval = { low: null, high: null }
  for (const token of tokens) {
    const part = comparatorInterval(token)
    if (part === null) return null
    interval = intersect(interval, part)
  }
  return interval
}

/** Every version of a line: Node and Bun `22` is 22.x, Rust `1.80` is 1.80.x. */
function lineInterval(runtime: Runtime, line: string): Interval | null {
  const parts = partial(line)
  if (parts === null || parts.length === 0) return null
  const kept = runtime === 'rust' || parts.length > 1 ? parts.slice(0, 2) : parts.slice(0, 1)
  const past = pastPartial(kept)
  return past
    ? { low: { version: padded(kept), inclusive: true }, high: { version: past, inclusive: false } }
    : null
}

/**
 * True when some version of `line` satisfies the npm style range (`>=20 <23`, `^22 || ^24`,
 * `20.x`, `18 - 22`). A range or line that cannot be read counts as satisfied, so an odd value
 * never raises a disagreement.
 */
export function lineSatisfies(runtime: Runtime, range: string, line: string): boolean {
  const lineSpan = lineInterval(runtime, line)
  if (lineSpan === null) return true
  for (const alternative of range.split('||')) {
    const text = alternative.trim()
    if (text === '' || text === '*' || text.toLowerCase() === 'x') return true
    const interval = alternativeInterval(text)
    if (interval === null || !isEmpty(intersect(interval, lineSpan))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Fix hints

/** The target written with as many parts as the pin has (`24`, `24.22`, `24.22.2`). */
function targetText(target: SupportTarget, precision: number): string {
  const source = parseVersion(target.latest) ?? parseVersion(target.line)
  if (source === null) return target.line
  const wanted = Math.max(precision, versionPrecision(target.line))
  const fromLatest = versionPrecision(target.latest) >= wanted
  const parts = fromLatest ? source : (parseVersion(target.line) ?? source)
  return parts.slice(0, Math.max(1, Math.min(3, wanted))).join('.')
}

/** Replaces the first whole occurrence of `version` in `raw`; null when it is not there. */
function replaceVersion(raw: string, version: string, next: string): string | null {
  let from = 0
  for (;;) {
    const at = raw.indexOf(version, from)
    if (at === -1) return null
    const before = raw[at - 1] ?? ''
    const after = raw[at + version.length] ?? ''
    if (!/[\d.]/.test(before) && !/[\d.]/.test(after)) {
      return raw.slice(0, at) + next + raw.slice(at + version.length)
    }
    from = at + 1
  }
}

const SINGLE_COMPARATOR = /^\s*(>=|>|\^|~>|~|=)?\s*v?(\d{1,9}(?:\.\d{1,9}){0,2})(\.[xX*])?\s*$/

/** The pin rewritten to the target line. */
export function retarget(pin: RuntimePinRecord, target: SupportTarget): string {
  if (pin.kind === 'range') {
    const single = SINGLE_COMPARATOR.exec(pin.raw)
    if (single) {
      const next = targetText(target, versionPrecision(single[2]!))
      return replaceVersion(pin.raw, single[2]!, next) ?? `>=${next}`
    }
    return `>=${targetText(target, 1)}`
  }
  const next = targetText(target, versionPrecision(pin.version))
  if (pin.version !== null) {
    const replaced = replaceVersion(pin.raw, pin.version, next)
    if (replaced !== null) return replaced
  }
  return next
}

/** True when the pin is already on the target line or newer. */
function onOrPast(pin: RuntimePinRecord, target: SupportTarget): boolean {
  const line = comparableLine(pin)
  const have = parseVersion(line)
  const want = parseVersion(target.line)
  if (have === null || want === null) return false
  const span = pin.runtime === 'node' ? 1 : 2
  return compareVersions(padded(have.slice(0, span)), padded(want.slice(0, span))) >= 0
}

/**
 * One hint per file that pins the runtime to a line (section 5.6): every exact or range pin that
 * is not on the target yet, the CI and build stage pins included. Floating pins move by
 * themselves, unreadable ones have nothing to rewrite, and a minimum (Cargo `rust-version`) is
 * not what runs.
 */
export function fixHintsFor(
  pins: readonly RuntimePinRecord[],
  runtime: Runtime,
  target: SupportTarget | null,
  only?: (pin: RuntimePinRecord) => boolean,
): FixHint[] {
  if (target === null) return []
  const hints: FixHint[] = []
  for (const pin of pins) {
    if (pin.runtime !== runtime || (pin.kind !== 'exact' && pin.kind !== 'range')) continue
    if (isBunMajorOnly(pin) || (only ? !only(pin) : onOrPast(pin, target))) continue
    const to = retarget(pin, target)
    if (to !== pin.raw) hints.push({ path: pin.path, line: pin.line, from: pin.raw, to })
  }
  return hints
}
