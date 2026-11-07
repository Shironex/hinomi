export type ContainerMountType = 'bind' | 'volume' | 'tmpfs' | 'other'

/** One mount of a container, from a compose volume or a `-v` / `--mount` run option. */
export interface ContainerMount {
  type: ContainerMountType
  /** Host path or volume name; null for an anonymous volume or tmpfs. */
  source: string | null
  target: string | null
  readOnly: boolean
}

/** Paths whose mount hands the container the Docker daemon: the socket, or a parent of it. */
const SOCKET_PATHS = new Set([
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run',
  '/run',
  '/var',
  '/',
])

/** True when a host path is the Docker socket or a directory that contains it. */
export function isDockerSocketPath(path: string): boolean {
  const normalised = path.replace(/\/+/g, '/')
  const trimmed = normalised.length > 1 ? normalised.replace(/\/$/, '') : normalised
  return SOCKET_PATHS.has(trimmed)
}

/** True when any bind mount in the list exposes the Docker socket (read only mounts too). */
export function mountsDockerSocket(mounts: readonly ContainerMount[]): boolean {
  return mounts.some((m) => m.type === 'bind' && m.source !== null && isDockerSocketPath(m.source))
}

/** A short syntax source is a host path when it starts like one. */
function sourceType(source: string): ContainerMountType {
  if (/^(\/|\.{1,2}(\/|$)|~)/.test(source)) return 'bind'
  if (source.includes('$')) return 'other'
  return 'volume'
}

/**
 * Parses the short form `SRC:DST[:mode]` (compose `volumes:` and `docker run -v`). A single
 * part is an anonymous volume at that target. Modes are a comma list; `ro` makes it read only.
 */
export function parseVolumeSpec(spec: string): ContainerMount {
  const parts = spec.trim().split(':')
  if (parts.length === 1) {
    return { type: 'volume', source: null, target: parts[0] || null, readOnly: false }
  }
  const [source = '', target = '', mode = ''] = parts
  return {
    type: sourceType(source),
    source: source || null,
    target: target || null,
    readOnly: mode.split(',').includes('ro'),
  }
}
