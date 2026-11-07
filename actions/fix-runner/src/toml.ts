import { FixRunnerError } from './errors.js'

// Just enough TOML for Cargo.toml, Cargo.lock and .cargo/config.toml: a scanner that walks
// the tables and key/value pairs of a document and reports where each value sits in the
// text, so an edit replaces those characters only and leaves comments, order and layout as
// they were. Values are not converted to data beyond plain strings and booleans.

export interface TomlEntry {
  /** Header of the table the pair is in, e.g. `['target', 'cfg(unix)', 'dependencies']`. */
  table: string[]
  /** True when the header is an array of tables (`[[package]]`). */
  arrayTable: boolean
  /** Running number of the table, so pairs of two `[[package]]` blocks can be told apart. */
  tableIndex: number
  /** The dotted key, e.g. `['serde', 'version']`. */
  key: string[]
  /** Offsets of the value in the document text, end exclusive. */
  start: number
  end: number
}

const BARE_KEY = /[A-Za-z0-9_-]/
const WHITESPACE = new Set([' ', '\t'])

class Scanner {
  i = 0
  constructor(readonly text: string) {}

  peek(): string {
    return this.text[this.i] ?? ''
  }

  fail(message: string): never {
    const line = this.text.slice(0, this.i).split('\n').length
    throw new FixRunnerError(`TOML: ${message} on line ${line}`)
  }

  skipSpaces() {
    while (WHITESPACE.has(this.peek())) this.i++
  }

  /** Skips spaces, newlines and comments. */
  skipBlank() {
    for (;;) {
      const c = this.peek()
      if (WHITESPACE.has(c) || c === '\n' || c === '\r') this.i++
      else if (c === '#') this.skipComment()
      else return
    }
  }

  skipComment() {
    while (this.i < this.text.length && this.peek() !== '\n') this.i++
  }

  /** After a pair or header: spaces, an optional comment and the end of the line. */
  endLine() {
    this.skipSpaces()
    if (this.peek() === '#') this.skipComment()
    if (this.peek() === '\r') this.i++
    if (this.i < this.text.length && this.peek() !== '\n') this.fail('expected the end of the line')
  }

  key(): string[] {
    const parts: string[] = []
    for (;;) {
      this.skipSpaces()
      parts.push(this.keyPart())
      this.skipSpaces()
      if (this.peek() !== '.') return parts
      this.i++
    }
  }

  keyPart(): string {
    const c = this.peek()
    if (c === '"' || c === "'") {
      const start = this.i
      this.skipString()
      return decodeString(this.text.slice(start, this.i)) ?? this.fail('unsupported quoted key')
    }
    const start = this.i
    while (BARE_KEY.test(this.peek())) this.i++
    if (this.i === start) this.fail('expected a key')
    return this.text.slice(start, this.i)
  }

  skipString() {
    const quote = this.peek()
    const triple = this.text.startsWith(quote.repeat(3), this.i)
    if (triple) {
      const close = this.text.indexOf(quote.repeat(3), this.i + 3)
      if (close === -1) this.fail('unterminated string')
      this.i = close + 3
      // A closing run may hold up to two more quotes that belong to the string.
      while (this.peek() === quote && this.i - close < 5) this.i++
      return
    }
    this.i++
    while (this.i < this.text.length) {
      const c = this.peek()
      if (c === '\n') break
      if (c === '\\' && quote === '"') {
        this.i += 2
        continue
      }
      this.i++
      if (c === quote) return
    }
    this.fail('unterminated string')
  }

  /** Moves past one value: string, array, inline table or a bare scalar. */
  skipValue() {
    const c = this.peek()
    if (c === '"' || c === "'") return this.skipString()
    if (c === '[' || c === '{') return this.skipContainer()
    const start = this.i
    while (this.i < this.text.length && !/[\s,\]}#]/.test(this.peek())) this.i++
    if (this.i === start) this.fail('expected a value')
  }

  skipContainer() {
    const close = this.peek() === '[' ? ']' : '}'
    this.i++
    for (;;) {
      this.skipBlank()
      const c = this.peek()
      if (c === '') this.fail('unterminated array or inline table')
      if (c === close) {
        this.i++
        return
      }
      if (c === ',') {
        this.i++
        continue
      }
      if (close === '}') {
        this.key()
        this.skipSpaces()
        if (this.peek() !== '=') this.fail('expected =')
        this.i++
        this.skipSpaces()
      }
      this.skipValue()
    }
  }
}

/** Every key/value pair of a TOML document in order. Throws FixRunnerError when malformed. */
export function scanToml(text: string): TomlEntry[] {
  const s = new Scanner(text)
  const entries: TomlEntry[] = []
  let table: string[] = []
  let arrayTable = false
  let tableIndex = 0
  for (;;) {
    s.skipBlank()
    if (s.i >= text.length) return entries
    if (s.peek() === '[') {
      arrayTable = text[s.i + 1] === '['
      s.i += arrayTable ? 2 : 1
      table = s.key()
      if (!text.startsWith(arrayTable ? ']]' : ']', s.i)) s.fail('expected ] after a table name')
      s.i += arrayTable ? 2 : 1
      tableIndex++
      s.endLine()
      continue
    }
    const key = s.key()
    if (s.peek() !== '=') s.fail('expected =')
    s.i++
    s.skipSpaces()
    const start = s.i
    s.skipValue()
    entries.push({ table, arrayTable, tableIndex, key, start, end: s.i })
    s.endLine()
  }
}

/** The pairs inside an inline table that spans `text[start, end)`, offsets absolute. */
export function scanInlineTable(text: string, start: number, end: number): TomlEntry[] {
  const s = new Scanner(text.slice(0, end))
  s.i = start
  if (s.peek() !== '{') return []
  s.i++
  const entries: TomlEntry[] = []
  for (;;) {
    s.skipBlank()
    if (s.peek() === '}' || s.i >= end) return entries
    if (s.peek() === ',') {
      s.i++
      continue
    }
    const key = s.key()
    s.skipSpaces()
    if (s.peek() !== '=') s.fail('expected =')
    s.i++
    s.skipSpaces()
    const valueStart = s.i
    s.skipValue()
    entries.push({ table: [], arrayTable: false, tableIndex: 0, key, start: valueStart, end: s.i })
  }
}

/**
 * A single line string literal's text, null for anything else (multi line strings, escapes
 * other than `\"` and `\\`). Dependency versions and names never need more.
 */
export function decodeString(raw: string): string | null {
  if (raw.length < 2 || raw.startsWith('"""') || raw.startsWith("'''")) return null
  const quote = raw[0]
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote) return null
  const body = raw.slice(1, -1)
  if (quote === "'") return body
  if (/\\[^"\\]/.test(body)) return null
  return body.replace(/\\(["\\])/g, '$1')
}

/** The value of a pair as a plain string or boolean, null for anything else. */
export function scalarValue(text: string, entry: TomlEntry): string | boolean | null {
  const raw = text.slice(entry.start, entry.end)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return decodeString(raw)
}
