// Coolify watch path matching, shared by the fix run warning and the watch path guard.

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** A Coolify watch path as a regular expression: `**` crosses folders, `*` and `?` do not. */
export function watchPathRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*' && pattern[i + 1] === '*') {
      // `**/` also matches no folder at all, so `src/**/a.ts` matches `src/a.ts`.
      const slash = pattern[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

/**
 * True when Coolify would deploy a change to `file` under these watch paths: patterns are read
 * in order, `!` negates, and the last pattern that matches wins. No patterns watch everything.
 */
export function watchPathsTrigger(patterns: readonly string[], file: string): boolean {
  const lines = patterns.map((p) => p.trim()).filter((p) => p !== '' && p !== '!')
  if (lines.length === 0) return true
  let triggered = false
  for (const line of lines) {
    const negated = line.startsWith('!')
    const glob = (negated ? line.slice(1) : line).replace(/^\/+/, '')
    if (watchPathRegExp(glob).test(file)) triggered = !negated
  }
  return triggered
}
