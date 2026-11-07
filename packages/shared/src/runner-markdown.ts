// Markdown helpers for the PR bodies Hinomi renders (the fix PR and the majors PR). Internal to
// packages/shared: not exported from the package index.

/** Text for a table cell: pipes escaped, line breaks folded into spaces. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ')
}

/** Inline code safe for a table cell. */
export function code(text: string): string {
  return `\`${cell(text).replace(/`/g, "'")}\``
}

export function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

/** A fenced text block whose fence is longer than any backtick run inside. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}\n${fence}`
}
