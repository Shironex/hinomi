/** Looks a variable up; `undefined` means it is not set. */
export type VariableLookup = (name: string) => string | undefined

/**
 * Which escape the text follows: a Dockerfile writes a literal dollar as `\$`, a compose file
 * writes `$$`.
 */
export type SubstitutionDialect = 'dockerfile' | 'compose'

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/

/** Index of the `}` that closes the `${` opened before `start`, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 1
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return -1
}

/** Splits the inside of `${...}` into the name and an optional operator with its word. */
function splitExpression(inner: string): { name: string; operator: string; word: string } | null {
  let end = 0
  while (end < inner.length && NAME_CHAR.test(inner.charAt(end))) end++
  const name = inner.slice(0, end)
  if (!name || !NAME_START.test(name.charAt(0))) return null
  const rest = inner.slice(end)
  if (rest === '') return { name, operator: '', word: '' }
  const operator = /^:?[-+?]/.exec(rest)?.[0]
  if (operator === undefined) return null
  return { name, operator, word: rest.slice(operator.length) }
}

/** The value of one `${name<operator>word}`, or null when it cannot be resolved. */
function evaluate(
  expression: { name: string; operator: string; word: string },
  lookup: VariableLookup,
  dialect: SubstitutionDialect,
): string | null {
  const { name, operator, word } = expression
  const value = lookup(name)
  const colon = operator.startsWith(':')
  const unset = value === undefined || (colon && value === '')
  const kind = operator.slice(-1)
  if (kind === '') return value ?? null
  if (kind === '-') return unset ? substituteVariables(word, lookup, dialect) : (value ?? null)
  if (kind === '+') return unset ? '' : substituteVariables(word, lookup, dialect)
  // `?` demands the variable; without it the text has no value to read.
  return unset ? null : (value ?? null)
}

/**
 * Expands `$NAME`, `${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:+alt}` and
 * `${NAME+alt}`. Returns null when a variable is needed and not set, so callers can tell
 * "unknown" from an empty string. Defaults may nest.
 */
export function substituteVariables(
  text: string,
  lookup: VariableLookup,
  dialect: SubstitutionDialect = 'dockerfile',
): string | null {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text.charAt(i)
    const next = text.charAt(i + 1)
    if (dialect === 'dockerfile' && char === '\\' && next === '$') {
      out += '$'
      i += 2
      continue
    }
    if (char !== '$') {
      out += char
      i++
      continue
    }
    if (dialect === 'compose' && next === '$') {
      out += '$'
      i += 2
      continue
    }
    if (next === '{') {
      const close = closingBrace(text, i + 2)
      if (close === -1) return null
      const expression = splitExpression(text.slice(i + 2, close))
      if (!expression) return null
      const value = evaluate(expression, lookup, dialect)
      if (value === null) return null
      out += value
      i = close + 1
      continue
    }
    if (NAME_START.test(next)) {
      let end = i + 1
      while (end < text.length && NAME_CHAR.test(text.charAt(end))) end++
      const value = lookup(text.slice(i + 1, end))
      if (value === undefined) return null
      out += value
      i = end
      continue
    }
    out += char
    i++
  }
  return out
}
