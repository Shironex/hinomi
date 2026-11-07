import { imageTagVersion, type ImageRef, type PinKind, type Runtime } from '@hinomi/shared'

// Turns the text of a pin into what the checks use: how it constrains the runtime, the version
// normalised, and the endoflife.date release name (`lineName`) when it names one. Pure, and the
// text comes from scanned files, so it only ever matches patterns and never indexes by it.

export interface PinValue {
  kind: PinKind
  /** Normalised: `22`, `22.11.0`, a range as written, a channel (`lts`). Null for `unknown`. */
  version: string | null
  /** The release name the line check looks up: Node and Bun major, Rust `major.minor`. */
  lineName: string | null
}

const UNKNOWN: PinValue = { kind: 'unknown', version: null, lineName: null }

/** Node LTS codenames, as `lts/<name>` in nvm and as image tags. */
const NODE_CODENAMES = new Map<string, string>([
  ['argon', '4'],
  ['boron', '6'],
  ['carbon', '8'],
  ['dubnium', '10'],
  ['erbium', '12'],
  ['fermium', '14'],
  ['gallium', '16'],
  ['hydrogen', '18'],
  ['iron', '20'],
  ['jod', '22'],
  ['krypton', '24'],
])

const FLOATING: Record<Runtime, ReadonlySet<string>> = {
  node: new Set(['lts', 'lts/*', 'current', 'latest', 'node', 'stable', 'newest', '*', 'x']),
  bun: new Set(['latest', 'canary', '*', 'x']),
  rust: new Set(['latest']),
}

const RUST_CHANNEL = /^(stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?(?:-[a-z0-9_]+){0,5}$/
const RUST_TRIPLE = /^(\d+\.\d+(?:\.\d+)?)(?:-[a-z0-9_]+){2,5}$/
const EXACT = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]+)?$/
const COMPARATOR = /^(?:>=|<=|>|<|=|\^|~>|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/

/** The text without quotes and a leading `v` or `=` in front of a number. */
export function cleanPinText(raw: string): string {
  let text = raw.trim()
  const quote = text[0]
  if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length >= 2) {
    text = text.slice(1, -1).trim()
  }
  return text.replace(/^[v=]+(?=\d)/i, '')
}

function lineOf(runtime: Runtime, parts: (number | null)[]): string | null {
  const [major, minor] = parts
  if (major === null || major === undefined) return null
  if (runtime === 'rust') return minor === null || minor === undefined ? null : `${major}.${minor}`
  return String(major)
}

type Floor = [number, number | null, number | null]

function compareFloor(a: Floor, b: Floor): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function numberOf(part: string | undefined): number | null {
  return part !== undefined && /^\d+$/.test(part) ? Number(part) : null
}

/** The lowest version a range allows, null when it has no lower bound. */
function rangeFloor(range: string): Floor | null {
  let floor: Floor | null = null
  for (const alternative of range.split('||')) {
    const text = alternative.trim()
    const tokens = / - /.test(text) ? [text.split(' - ')[0] ?? ''] : text.split(/[\s,]+/)
    let low: Floor | null = null
    for (const token of tokens) {
      if (token === '' || token.startsWith('<')) continue
      const match = COMPARATOR.exec(token)
      if (!match) continue
      const major = numberOf(match[1])
      if (major === null) continue
      const candidate: Floor = [major, numberOf(match[2]), numberOf(match[3])]
      if (low === null || compareFloor(candidate, low) > 0) low = candidate
    }
    if (low === null) return null
    if (floor === null || compareFloor(low, floor) < 0) floor = low
  }
  return floor
}

export interface PinValueOptions {
  /** The text is an `engines` style range: `*` is a range with no floor, not a floating channel. */
  range?: boolean
}

/** Reads a pin value for a runtime. */
export function readPinValue(
  runtime: Runtime,
  raw: string,
  options: PinValueOptions = {},
): PinValue {
  const text = cleanPinText(raw)
  if (text === '') return UNKNOWN
  const lower = text.toLowerCase()

  if (runtime === 'node') {
    const codename = /^lts\/([a-z]+)$/.exec(lower)?.[1]
    if (codename !== undefined) {
      const line = NODE_CODENAMES.get(codename)
      return line === undefined ? UNKNOWN : { kind: 'exact', version: line, lineName: line }
    }
    if (/^lts\/-\d+$/.test(lower)) return { kind: 'floating', version: 'lts', lineName: null }
  }

  if (runtime === 'rust') {
    const channel = RUST_CHANNEL.exec(lower)?.[1]
    if (channel !== undefined) return { kind: 'floating', version: channel, lineName: null }
    const triple = RUST_TRIPLE.exec(lower)?.[1]
    if (triple !== undefined) return readPinValue(runtime, triple)
  }

  const isRangeChannel = options.range === true && (lower === '*' || lower === 'x')
  if (!isRangeChannel && FLOATING[runtime].has(lower)) {
    return { kind: 'floating', version: lower === 'lts/*' ? 'lts' : lower, lineName: null }
  }

  const exact = EXACT.exec(text)
  if (exact) {
    const parts = [exact[1], exact[2], exact[3]]
    const numbers = parts.map(numberOf)
    const version = numbers.filter((n): n is number => n !== null).join('.')
    // `rust:1` and `rust = "1"` mean the newest 1.x: that is a channel, not a line.
    if (runtime === 'rust' && numbers[1] === null) {
      return { kind: 'floating', version, lineName: null }
    }
    return { kind: 'exact', version, lineName: lineOf(runtime, numbers) }
  }

  if (/[<>^~|*xX\s]/.test(text)) {
    const floor = rangeFloor(text)
    return {
      kind: 'range',
      version: text.replace(/\s+/g, ' '),
      lineName: floor === null ? null : lineOf(runtime, floor),
    }
  }
  return UNKNOWN
}

const IMAGE_CHANNELS = new Set(['lts', 'current', 'latest', 'canary', 'nightly', 'beta', 'stable'])

/**
 * The pin an image tag gives: `22-alpine` is line 22, `lts-jod` is 22, `lts` and `latest` float,
 * a tag with no version in it (`alpine`, `slim`) is the newest image, a digest without a tag is
 * unknown.
 */
export function readImagePin(runtime: Runtime, ref: ImageRef): PinValue {
  if (ref.tag === null) {
    return ref.digest === null ? { kind: 'floating', version: 'latest', lineName: null } : UNKNOWN
  }
  const tag = ref.tag.toLowerCase()
  if (runtime === 'node') {
    const codename = /^(?:lts-)?([a-z]+)(?:$|-)/.exec(tag)?.[1]
    const line = codename === undefined ? undefined : NODE_CODENAMES.get(codename)
    if (line !== undefined) return { kind: 'exact', version: line, lineName: line }
  }
  const version = imageTagVersion(ref)
  if (version !== null) return readPinValue(runtime, version)
  const word = /^[a-z]+/.exec(tag)?.[0] ?? ''
  return {
    kind: 'floating',
    version: IMAGE_CHANNELS.has(word) ? word : 'latest',
    lineName: null,
  }
}
