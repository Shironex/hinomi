/** A parsed `[registry/][namespace/]name[:tag][@digest]` image reference. */
export interface ImageRef {
  raw: string
  /** Registry host, or null for Docker Hub written without one. */
  registry: string | null
  /** Path without the registry; Docker Hub's `library/` prefix is dropped (`node`, `oven/bun`). */
  repository: string
  /** Last path part (`node`, `bun`). */
  name: string
  tag: string | null
  /** `sha256:...` when pinned by digest. */
  digest: string | null
}

export type ImageRuntime = 'node' | 'bun' | 'rust'

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io'])
const REPOSITORY_PART = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const DIGEST = /^[A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}$/

function splitTagAndDigest(
  raw: string,
): { path: string; tag: string | null; digest: string | null } | null {
  let path = raw
  let digest: string | null = null
  const at = path.indexOf('@')
  if (at !== -1) {
    digest = path.slice(at + 1)
    path = path.slice(0, at)
    if (!DIGEST.test(digest)) return null
  }
  // A colon after the last slash is the tag; one before it is a registry port.
  const colon = path.lastIndexOf(':')
  if (colon > path.lastIndexOf('/')) {
    const tag = path.slice(colon + 1)
    if (!TAG.test(tag)) return null
    return { path: path.slice(0, colon), tag, digest }
  }
  return { path, tag: null, digest }
}

/**
 * Parses an image reference with no variables left in it. Returns null for anything that is
 * not a valid reference (empty, spaces, an unexpanded `$VAR`, uppercase repository).
 */
export function parseImageRef(raw: string): ImageRef | null {
  const text = raw.trim()
  if (text === '') return null
  const split = splitTagAndDigest(text)
  if (!split || split.path === '') return null

  const parts = split.path.split('/')
  const first = parts[0] ?? ''
  const hasRegistry =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = hasRegistry ? first : null
  const pathParts = hasRegistry ? parts.slice(1) : parts
  if (pathParts.length === 0 || !pathParts.every((part) => REPOSITORY_PART.test(part))) return null

  const hub = registry === null || DOCKER_HUB_HOSTS.has(registry)
  const trimmed =
    hub && pathParts.length > 1 && pathParts[0] === 'library' ? pathParts.slice(1) : pathParts
  return {
    raw: text,
    registry,
    repository: trimmed.join('/'),
    name: pathParts[pathParts.length - 1] ?? '',
    tag: split.tag,
    digest: split.digest,
  }
}

/** The runtime an image carries, for the runtimes Hinomi tracks. */
export function imageRuntime(ref: ImageRef): ImageRuntime | null {
  if (ref.name === 'node') return 'node'
  if (ref.name === 'rust') return 'rust'
  if (ref.repository === 'oven/bun' || ref.repository.endsWith('/oven/bun')) return 'bun'
  return null
}

/**
 * The leading version of a tag: `22-alpine` gives `22`, `22.11-bookworm-slim` gives `22.11`,
 * `1.82.0-slim` gives `1.82.0`. Null for `lts`, `latest`, `alpine`, no tag, or a digest only.
 */
export function imageTagVersion(ref: ImageRef): string | null {
  if (ref.tag === null) return null
  return /^v?(\d+(?:\.\d+){0,2})(?:$|[-_])/.exec(ref.tag)?.[1] ?? null
}

/** True when the tag says the image runs as a non root user (`nonroot`, `debug-nonroot`). */
export function hasNonrootTag(ref: ImageRef): boolean {
  return ref.tag !== null && ref.tag.toLowerCase().endsWith('nonroot')
}
