/**
 * A small, forgiving TOML reader for lockfiles (uv.lock, poetry.lock). It covers what those files
 * use: tables, arrays of tables, dotted keys, strings (basic, literal, multi line), numbers,
 * booleans, dates (kept as text), arrays and inline tables. A statement it cannot read is skipped,
 * so one odd line never costs the whole file.
 */
export type TomlTable = { [key: string]: TomlValue }
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable

/** Tables have no prototype, so a key like `__proto__` is plain data and nothing can leak out. */
const newTable = (): TomlTable => Object.create(null) as TomlTable

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A value as an array, a lone table or scalar becoming empty. */
export const asArray = (value: unknown): TomlValue[] =>
  Array.isArray(value) ? (value as TomlValue[]) : []

/** A value as a table, anything else becoming an empty one. */
export const asTable = (value: unknown): TomlTable => (isTable(value) ? value : newTable())

export const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

class Reader {
  pos = 0
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? ''
  }

  /** Spaces and tabs only, optionally comments and newlines too. */
  skipSpace(multiline = false): void {
    while (!this.done) {
      const c = this.peek()
      if (c === ' ' || c === '\t') this.pos++
      else if (multiline && (c === '\n' || c === '\r')) this.pos++
      else if (multiline && c === '#') this.skipLine()
      else break
    }
  }

  skipLine(): void {
    while (!this.done && this.peek() !== '\n') this.pos++
  }

  eat(char: string): void {
    if (this.peek() !== char) throw new Error(`expected ${char}`)
    this.pos++
  }

  basicString(): string {
    const multi = this.text.startsWith('"""', this.pos)
    this.pos += multi ? 3 : 1
    if (multi && this.peek() === '\n') this.pos++
    let out = ''
    while (!this.done) {
      const c = this.peek()
      if (multi ? this.text.startsWith('"""', this.pos) : c === '"') {
        this.pos += multi ? 3 : 1
        return out
      }
      if (!multi && c === '\n') throw new Error('unterminated string')
      this.pos++
      if (c !== '\\') {
        out += c
        continue
      }
      const e = this.peek()
      this.pos++
      if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8
        out += String.fromCodePoint(parseInt(this.text.slice(this.pos, this.pos + len), 16))
        this.pos += len
      } else if (e === '\n' || e === '\r' || e === ' ' || e === '\t') {
        // Line ending backslash in a multi line string trims the whitespace that follows.
        while (/\s/.test(this.peek())) this.pos++
      } else out += ESCAPES[e] ?? e
    }
    throw new Error('unterminated string')
  }

  literalString(): string {
    const multi = this.text.startsWith("'''", this.pos)
    const quote = multi ? "'''" : "'"
    this.pos += quote.length
    if (multi && this.peek() === '\n') this.pos++
    const end = this.text.indexOf(quote, this.pos)
    if (end === -1) throw new Error('unterminated string')
    const out = this.text.slice(this.pos, end)
    this.pos = end + quote.length
    return out
  }

  /** A bare key, a quoted key, or a dotted path of them. */
  keyPath(): string[] {
    const parts: string[] = []
    for (;;) {
      this.skipSpace()
      const c = this.peek()
      if (c === '"') parts.push(this.basicString())
      else if (c === "'") parts.push(this.literalString())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos, this.pos + 256))
        if (!m) throw new Error('bad key')
        parts.push(m[0])
        this.pos += m[0].length
      }
      this.skipSpace()
      if (parts.some((p) => FORBIDDEN_KEYS.has(p))) throw new Error('forbidden key')
      if (this.peek() !== '.') return parts
      this.pos++
    }
  }

  value(): TomlValue {
    this.skipSpace()
    const c = this.peek()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    if (c === '[') return this.array()
    if (c === '{') return this.inlineTable()
    const m = /^[^\s,\]}#]+/.exec(this.text.slice(this.pos, this.pos + 128))
    if (!m) throw new Error('bad value')
    this.pos += m[0].length
    const raw = m[0]
    if (raw === 'true') return true
    if (raw === 'false') return false
    const num = Number(raw.replace(/_/g, ''))
    return Number.isNaN(num) ? raw : num
  }

  array(): TomlValue[] {
    this.eat('[')
    const out: TomlValue[] = []
    for (;;) {
      this.skipSpace(true)
      if (this.peek() === ']') {
        this.pos++
        return out
      }
      out.push(this.value())
      this.skipSpace(true)
      if (this.peek() === ',') this.pos++
      else if (this.peek() !== ']') throw new Error('bad array')
    }
  }

  inlineTable(): TomlTable {
    this.eat('{')
    const table = newTable()
    for (;;) {
      this.skipSpace(true)
      if (this.peek() === '}') {
        this.pos++
        return table
      }
      const path = this.keyPath()
      this.skipSpace()
      this.eat('=')
      setPath(table, path, this.value())
      this.skipSpace(true)
      if (this.peek() === ',') this.pos++
      else if (this.peek() !== '}') throw new Error('bad inline table')
    }
  }
}

/** Walks `path` below `root`, creating tables; an array of tables resolves to its last entry. */
function descend(root: TomlTable, path: string[]): TomlTable {
  let at = root
  for (const key of path) {
    let next = at[key]
    if (Array.isArray(next)) next = next[next.length - 1]
    if (!isTable(next)) {
      next = newTable()
      at[key] = next
    }
    at = next
  }
  return at
}

function setPath(table: TomlTable, path: string[], value: TomlValue): void {
  descend(table, path.slice(0, -1))[path.at(-1)!] = value
}

/** Parses TOML text into plain objects. Unreadable statements are skipped. */
export function parseToml(text: string): TomlTable {
  const reader = new Reader(text)
  const root = newTable()
  let current = root
  while (!reader.done) {
    const start = reader.pos
    let header = false
    try {
      reader.skipSpace(true)
      if (reader.done) break
      header = reader.peek() === '['
      if (reader.peek() === '[') {
        const isArray = reader.peek(1) === '['
        reader.pos += isArray ? 2 : 1
        const path = reader.keyPath()
        reader.skipSpace()
        reader.eat(']')
        if (isArray) reader.eat(']')
        if (isArray) {
          const parent = descend(root, path.slice(0, -1))
          const key = path.at(-1)!
          const list = Array.isArray(parent[key]) ? parent[key] : []
          const entry = newTable()
          list.push(entry)
          parent[key] = list
          current = entry
        } else current = descend(root, path)
      } else {
        const path = reader.keyPath()
        reader.skipSpace()
        reader.eat('=')
        setPath(current, path, reader.value())
      }
      reader.skipSpace()
      if (reader.peek() === '#') reader.skipLine()
    } catch {
      // A broken header must not hand its keys to the previous table: park them in a detached one.
      if (header) current = newTable()
      // Resynchronise on the next line.
      if (reader.pos <= start) reader.pos = start + 1
      reader.skipLine()
    }
  }
  return root
}
