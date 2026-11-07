/**
 * Splits a shell style line into words the way a POSIX shell would for plain arguments:
 * whitespace (newlines included) separates words, single quotes are literal, double quotes keep
 * spaces and honour `\"`, `\\`, `\$` and a backtick escape, and a backslash outside quotes escapes
 * the next character. A backslash before a newline joins the lines. No expansion happens, and an
 * unterminated quote runs to the end of the line.
 */
export function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i)

    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }

    if (char === '\\') {
      const next = line.charAt(i + 1)
      if (next === '\n' || next === '\r') {
        i += next === '\r' && line.charAt(i + 2) === '\n' ? 2 : 1
        continue
      }
      if (quote === '"' && !'"\\$`'.includes(next)) {
        current += char
        inWord = true
        continue
      }
      if (i + 1 < line.length) {
        current += next
        inWord = true
        i++
      }
      continue
    }

    if (quote === '"') {
      if (char === '"') quote = null
      else current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      inWord = true
      continue
    }

    if (/\s/.test(char)) {
      if (inWord) tokens.push(current)
      current = ''
      inWord = false
      continue
    }

    current += char
    inWord = true
  }

  if (inWord) tokens.push(current)
  return tokens
}
