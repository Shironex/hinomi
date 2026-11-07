import type { ImageRef } from '@hinomi/shared'

// Where an image reference lives in the OCI distribution API: the registry host (Docker Hub's
// short names expanded), the repository path as the registry knows it, and the reference
// (digest, else tag, else `latest`).

/** Docker Hub's API host; `docker.io` and short names (`node`, `oven/bun`) live there. */
export const DOCKER_HUB_API_HOST = 'registry-1.docker.io'
const DOCKER_HUB_NAMES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io'])

/** A registry host with an optional port, no scheme, no path. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i

export interface RegistryTarget {
  /** Host (and port) the API is called on. */
  host: string
  /** Repository path in the registry (`library/node` on Docker Hub). */
  repository: string
  /** Tag, or null when the reference is pinned by digest only. */
  tag: string | null
  /** `sha256:...` when the reference is pinned. */
  digest: string | null
}

/** The registry target of a parsed image reference; null when the host is not a plain host. */
export function registryTarget(ref: ImageRef): RegistryTarget | null {
  const hub = ref.registry === null || DOCKER_HUB_NAMES.has(ref.registry.toLowerCase())
  const host = hub ? DOCKER_HUB_API_HOST : ref.registry!.toLowerCase()
  if (!HOST.test(host)) return null
  const repository =
    hub && !ref.repository.includes('/') ? `library/${ref.repository}` : ref.repository
  return {
    host,
    repository,
    tag: ref.digest ? ref.tag : (ref.tag ?? 'latest'),
    digest: ref.digest,
  }
}

/** A short name for logs and notes: `host/repository:tag@digest`. */
export function targetName(target: RegistryTarget): string {
  return `${target.host}/${target.repository}${target.tag ? `:${target.tag}` : ''}${
    target.digest ? `@${target.digest}` : ''
  }`
}
