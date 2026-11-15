import {
  parseVolumeSpec,
  type DeploymentFacts,
  type FactMount,
  type FactNetwork,
} from '@hinomi/shared'
import { containerInspectSchema, type ContainerInspect } from './schemas.js'
import { projectOf, type Labels } from './labels.js'

// Container inspect to deployment facts (docs/design/phase-2.md sections 4.1 to 4.3). Inspect
// gives the running values, so nothing is guessed: `Config.User` (empty means root), every
// mount from `Mounts` and `HostConfig.Binds`, and the networks the container is attached to.

/** Network names that are not shared networks: no network, or the host's own. */
const NOT_SHARED = new Set(['none', 'host'])

const GAPS = {
  watchPaths: 'a Docker host has no watch paths, it runs what it was given',
  autoDeploy: 'a Docker host does not say whether deploys are automatic',
} as const

/**
 * Removes `Config.Env` from a raw inspect answer before anything else touches it. Environment
 * variables hold secrets; they are never parsed, kept or logged.
 */
export function stripEnv(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const config = (raw as { Config?: unknown }).Config
  if (typeof config === 'object' && config !== null && 'Env' in config) {
    delete (config as { Env?: unknown }).Env
  }
  return raw
}

/** A raw inspect answer, without env, validated; null when it is not one. */
export function parseInspect(raw: unknown): ContainerInspect | null {
  const parsed = containerInspectSchema.safeParse(stripEnv(raw))
  return parsed.success ? parsed.data : null
}

export function containerName(inspect: Pick<ContainerInspect, 'Name' | 'Id'>): string {
  const name = inspect.Name?.replace(/^\/+/, '').trim()
  return name || inspect.Id.slice(0, 12)
}

export function labelsOf(inspect: ContainerInspect): Labels {
  return inspect.Config?.Labels ?? {}
}

function mountType(type: string | null | undefined): FactMount['type'] {
  return type === 'bind' || type === 'volume' || type === 'tmpfs' ? type : 'other'
}

/** Every mount, from `Mounts` and the `HostConfig.Binds` strings, deduplicated by target. */
export function mountsOf(inspect: ContainerInspect): FactMount[] {
  const out: FactMount[] = []
  const seen = new Set<string>()
  const add = (mount: FactMount) => {
    const key = `${mount.type}|${mount.source ?? ''}|${mount.target ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(mount)
  }
  for (const m of inspect.Mounts ?? []) {
    const type = mountType(m.Type)
    add({
      origin: 'docker_inspect',
      type,
      // A volume's Source is its folder under /var/lib/docker; its name says more.
      source: (type === 'volume' ? (m.Name ?? m.Source) : m.Source) || null,
      target: m.Destination || null,
      readOnly: m.RW === false,
      service: null,
    })
  }
  for (const bind of inspect.HostConfig?.Binds ?? []) {
    const mount = parseVolumeSpec(bind)
    add({ origin: 'docker_inspect', ...mount, service: null })
  }
  return out
}

export function networksOf(inspect: ContainerInspect): FactNetwork[] {
  return Object.keys(inspect.NetworkSettings?.Networks ?? {})
    .filter((name) => !NOT_SHARED.has(name))
    .sort()
    .map((name) => ({ origin: 'docker_inspect' as const, name, service: null }))
}

/** True when a port is published on every interface of the host (`0.0.0.0`, `::` or empty). */
export function publishesPublicPort(inspect: ContainerInspect): boolean {
  for (const bindings of Object.values(inspect.NetworkSettings?.Ports ?? {})) {
    for (const binding of bindings ?? []) {
      const ip = (binding.HostIp ?? '').trim()
      if (binding.HostPort && (ip === '' || ip === '0.0.0.0' || ip === '::')) return true
    }
  }
  return false
}

export function factsOf(
  inspect: ContainerInspect,
  options: { fetchedAt: string; commit: string | null; project: string },
): DeploymentFacts {
  const networkMode = inspect.HostConfig?.NetworkMode ?? null
  return {
    version: 1,
    fetchedAt: options.fetchedAt,
    buildPack: null,
    image: inspect.Config?.Image || null,
    commit: options.commit,
    // The running user; Docker reports an empty string when none is set, which means root.
    user: inspect.Config?.User ?? '',
    userOrigin: 'docker_inspect',
    services: [],
    dockerfile: null,
    mounts: mountsOf(inspect),
    mountsChecked: ['docker_inspect'],
    networks: networksOf(inspect),
    hostNetwork: networkMode === 'host',
    privileged: inspect.HostConfig?.Privileged === true,
    destination: null,
    // Docker has no destinations: the networks above are the whole picture.
    attachedToDestination: false,
    project: { key: options.project, name: options.project, environment: null },
    autoDeploy: null,
    gaps: { ...GAPS },
  }
}

/** The project key of a container (compose project, `hinomi.project`, else its name). */
export function projectOfInspect(inspect: ContainerInspect): string {
  return projectOf(labelsOf(inspect), containerName(inspect))
}
