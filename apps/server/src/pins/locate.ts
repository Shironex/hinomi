// Line numbers for values read through a JSON or TOML parser, which drop positions.

/**
 * The 1 based line of every object key in a JSON text, by path (segments joined with NUL,
 * array elements by index). The first occurrence wins. Keys are only ever used as Map keys.
 */
export function jsonKeyLines(text: string): Map<string, number> {
  const lines = new Map<string, number>()
  type Frame = { array: boolean; key: string | null; index: number }
  const stack: Frame[] = []
  let line = 1
  let i = 0
  const segment = (frame: Frame) => (frame.array ? String(frame.index) : (frame.key ?? ''))
  while (i < text.length) {
    const c = text[i]!
    if (c === '\n') line++
    else if (c === '"') {
      const start = i
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++
        i++
      }
      const value = text.slice(start + 1, i)
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      const top = stack[stack.length - 1]
      if (text[j] === ':' && top && !top.array) {
        top.key = value
        const path = [...stack.slice(0, -1).map(segment), value].join('\u0000')
        if (!lines.has(path)) lines.set(path, line)
      }
    } else if (c === '{' || c === '[') {
      stack.push({ array: c === '[', key: null, index: 0 })
    } else if (c === '}' || c === ']') {
      stack.pop()
    } else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top?.array) top.index++
      else if (top) top.key = null
    }
    i++
  }
  return lines
}

export const jsonPath = (...segments: (string | number)[]): string => segments.join('\u0000')

const TABLE_HEADER = /^\s*\[\s*([^\][]+?)\s*\]\s*(?:#.*)?$/

function unquoteKey(part: string): string {
  const text = part.trim()
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text
}

/** The table a header names, `[tools]` or `[ "a" . b ]`, as a dotted path. */
function headerPath(header: string): string {
  return header.split('.').map(unquoteKey).join('.')
}

/**
 * The 1 based line where `key` is set in `table` of a TOML text (`''` is the root), also as a
 * dotted key from above (`tools.node = ...`). Null when it is not there.
 */
export function tomlKeyLine(text: string, table: string, key: string): number | null {
  const lines = text.split(/\r?\n/)
  let current = ''
  const direct = new RegExp(`^\\s*(?:"${escape(key)}"|'${escape(key)}'|${escape(key)})\\s*=`)
  const dotted = table
    ? new RegExp(
        `^\\s*${table.split('.').map(escape).join('\\s*\\.\\s*')}\\s*\\.\\s*(?:"${escape(key)}"|${escape(key)})\\s*=`,
      )
    : null
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!
    const header = TABLE_HEADER.exec(raw)
    if (header && !raw.trimStart().startsWith('[[')) {
      current = headerPath(header[1]!)
      continue
    }
    if (current === table && direct.test(raw)) return n + 1
    if (dotted && current === '' && dotted.test(raw)) return n + 1
  }
  return null
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The text of a TOML value on its line: `rust = 1.80 # note` gives `1.80`. */
export function tomlRawValue(text: string, line: number | null): string | null {
  if (line === null) return null
  const source = text.split(/\r?\n/)[line - 1]
  if (source === undefined) return null
  const value = /=\s*([^#]*)/.exec(source)?.[1]?.trim()
  return value === undefined || value === '' ? null : value
}
