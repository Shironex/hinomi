// Package URLs (purls) as endoflife.date publishes them (`pkg:npm/next`, `pkg:npm/%40angular/core`,
// `pkg:docker/library/node`). The index keys are a normal form so that a name read from a
// manifest and an identifier from the API meet: the type and every segment lowercased and
// percent decoded, without version, qualifiers or subpath.

const MAX_PURL_LENGTH = 512

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Normal form of a purl: `npm/@angular/core` for `pkg:npm/%40angular/core@19.0.0?x=y#z`.
 * Null when the text is not a purl with a type and a name.
 */
export function normalizePurl(raw: string): string | null {
  if (raw.length > MAX_PURL_LENGTH || !raw.toLowerCase().startsWith('pkg:')) return null
  let rest = raw.slice(4)
  for (const mark of ['#', '?']) {
    const at = rest.indexOf(mark)
    if (at >= 0) rest = rest.slice(0, at)
  }
  // Tolerate the optional `//` some tools write after `pkg:`.
  rest = rest.replace(/^\/+/, '')
  const segments = rest.split('/').map(decode)
  if (segments.length < 2 || segments.some((s) => s === '')) return null
  const last = segments.length - 1
  const name = segments[last] ?? ''
  const versionAt = name.indexOf('@')
  if (versionAt > 0) segments[last] = name.slice(0, versionAt)
  return segments.map((s) => s.toLowerCase()).join('/')
}

/** The purl key of a package of an ecosystem purl type (`npm`, `cargo`, `pypi`, ...). */
export function purlKey(type: string, name: string): string | null {
  const segments = [type, ...name.split('/')]
  if (name.length > MAX_PURL_LENGTH || segments.some((s) => s === '')) return null
  return segments.map((s) => s.toLowerCase()).join('/')
}
