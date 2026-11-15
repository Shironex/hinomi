import { normalizeRepo } from '../coolify/normalize.js'

// What container labels say about a deployment (docs/design/phase-2.md sections 9.2 and 9.3):
// the repo and branch it was built from, its domains (Hinomi's own label, else the router labels
// of Traefik or Caddy) and its project. Label values are only parsed, never fetched or followed.

export type Labels = Readonly<Record<string, string>>

export const LABEL = {
  repo: 'hinomi.repo',
  branch: 'hinomi.branch',
  domains: 'hinomi.domains',
  project: 'hinomi.project',
  ociSource: 'org.opencontainers.image.source',
  ociRevision: 'org.opencontainers.image.revision',
  composeProject: 'com.docker.compose.project',
  composeService: 'com.docker.compose.service',
} as const

const MAX_DOMAINS = 50

function label(labels: Labels, key: string): string | null {
  const value = labels[key]?.trim()
  return value ? value : null
}

/**
 * The repo as `owner/name`, and the raw value it came from. `hinomi.repo` wins: it is set on
 * purpose for this container, while the OCI source label can come from a base image.
 */
export function repoFromLabels(labels: Labels): { repo: string | null; raw: string | null } {
  for (const key of [LABEL.repo, LABEL.ociSource]) {
    const raw = label(labels, key)
    if (raw) return { repo: normalizeRepo(raw), raw }
  }
  return { repo: null, raw: null }
}

export function branchFromLabels(labels: Labels): string | null {
  return label(labels, LABEL.branch)
}

/** The deployed commit, when the OCI revision label holds a full sha. */
export function commitFromLabels(labels: Labels): string | null {
  const revision = label(labels, LABEL.ociRevision)
  return revision && /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : null
}

/** A host name as a router rule or a label writes it: letters, digits, dots, dashes, a wildcard. */
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i

function domainOf(host: string, scheme: 'http' | 'https'): string | null {
  const value = host.trim().toLowerCase().replace(/\.$/, '')
  if (!value || value.length > 253 || !HOST.test(value)) return null
  return `${scheme}://${value}`
}

/** `hinomi.domains`: comma or space separated, with or without a scheme (https when missing). */
function hinomiDomains(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,\s]+/)) {
    const match = /^(?:(https?):\/\/)?([^/:\s]+)(?::\d+)?\/?$/i.exec(part.trim())
    if (!match) continue
    const scheme = (match[1]?.toLowerCase() as 'http' | 'https' | undefined) ?? 'https'
    const domain = domainOf(match[2]!, scheme)
    if (domain) out.push(domain)
  }
  return out
}

/** Hosts in a Traefik rule: ``Host(`a`)``, ``Host(`a`, `b`)``, joined with `||` or `&&`. */
export function hostsOfTraefikRule(rule: string): string[] {
  const hosts: string[] = []
  for (const call of rule.matchAll(/\bHost\s*\(([^)]*)\)/g)) {
    for (const quoted of call[1]!.matchAll(/[`"']([^`"']+)[`"']/g)) hosts.push(quoted[1]!)
  }
  return hosts
}

/** Traefik http routers: `traefik.http.routers.<name>.rule`, https when the router has TLS. */
function traefikDomains(labels: Labels): string[] {
  if (label(labels, 'traefik.enable')?.toLowerCase() === 'false') return []
  const out: string[] = []
  for (const [key, value] of Object.entries(labels)) {
    const match = /^traefik\.http\.routers\.([^.]+)\.rule$/.exec(key)
    if (!match) continue
    const router = `traefik.http.routers.${match[1]}`
    const entrypoints = (label(labels, `${router}.entrypoints`) ?? '').toLowerCase()
    const tls =
      label(labels, `${router}.tls`)?.toLowerCase() === 'true' ||
      Object.keys(labels).some((k) => k.startsWith(`${router}.tls.`)) ||
      /\b(websecure|https)\b/.test(entrypoints)
    for (const host of hostsOfTraefikRule(value)) {
      const domain = domainOf(host, tls ? 'https' : 'http')
      if (domain) out.push(domain)
    }
  }
  return out
}

/**
 * Caddy docker proxy: `caddy` or `caddy_<n>` holds the site addresses. Caddy serves https unless
 * the address says `http://`; template values (`{{...}}`) and bare ports are skipped.
 */
function caddyDomains(labels: Labels): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(labels)) {
    if (!/^caddy(_\d+)?$/.test(key) || value.includes('{{')) continue
    for (const address of value.split(/[,\s]+/)) {
      const match = /^(?:(https?):\/\/)?([^/:\s]+)(?::\d+)?\/?$/i.exec(address.trim())
      if (!match) continue
      const domain = domainOf(match[2]!, match[1]?.toLowerCase() === 'http' ? 'http' : 'https')
      if (domain) out.push(domain)
    }
  }
  return out
}

/** Which labels gave the domains, for the docs and tests. */
export type DomainOrigin = 'hinomi' | 'traefik' | 'caddy' | null

/**
 * The domains of a container: `hinomi.domains` when set (it overrides the proxy labels), else
 * every host of its Traefik routers and Caddy sites. Deduplicated, capped, with a scheme.
 */
export function domainsFromLabels(labels: Labels): { domains: string[]; origin: DomainOrigin } {
  const own = label(labels, LABEL.domains)
  if (own) return { domains: unique(hinomiDomains(own)), origin: 'hinomi' }
  const traefik = traefikDomains(labels)
  const caddy = caddyDomains(labels)
  const origin: DomainOrigin = traefik.length > 0 ? 'traefik' : caddy.length > 0 ? 'caddy' : null
  return { domains: unique([...traefik, ...caddy]), origin }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_DOMAINS)
}

/** The compose project and service, when the container was started by compose. */
export function composeOf(labels: Labels): { project: string; service: string } | null {
  const project = label(labels, LABEL.composeProject)
  const service = label(labels, LABEL.composeService)
  return project && service ? { project, service } : null
}

/** Project key for the shared network check: compose project, else `hinomi.project`, else the name. */
export function projectOf(labels: Labels, containerName: string): string {
  return label(labels, LABEL.composeProject) ?? label(labels, LABEL.project) ?? containerName
}
