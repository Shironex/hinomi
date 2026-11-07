// A small .npmrc reader: `key=value` lines, `;` and `#` comments, `key[]=value` arrays.
// Values that use ${ENV} expansion are kept as written; the runner only reads plain settings.

export interface Npmrc {
  values: Map<string, string>
  lists: Map<string, string[]>
}

export function parseNpmrc(text: string | null): Npmrc {
  const values = new Map<string, string>()
  const lists = new Map<string, string[]>()
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
    if (key.endsWith('[]')) {
      const name = key.slice(0, -2)
      lists.set(name, [...(lists.get(name) ?? []), value])
    } else {
      values.set(key, value)
    }
  }
  return { values, lists }
}
