import type { DeploymentItem, FindingListItem } from '@hinomi/shared'
import { deploymentStatus, needsRepo } from './finding-meta'

/** Heat steps of the exposure map: 0, 1 to 34, 35 to 59, 60 or more exposed findings. */
export type HeatLevel = 0 | 1 | 2 | 3

export const HEAT_STEPS: readonly { level: HeatLevel; label: string }[] = [
  { level: 0, label: '0' },
  { level: 1, label: '1 to 34' },
  { level: 2, label: '35 to 59' },
  { level: 3, label: '60 or more exposed' },
]

export function heatLevel(exposed: number): HeatLevel {
  if (exposed >= 60) return 3
  if (exposed >= 35) return 2
  if (exposed > 0) return 1
  return 0
}

/** Advisory findings not fixed, every severity. */
export function openTotal(d: Pick<DeploymentItem, 'openFindings'>): number {
  const c = d.openFindings
  return c.critical + c.high + c.moderate + c.low
}

/** What a tile or row says about a deployment, in the order it is checked. */
export interface DeploymentFacts {
  /** A git source Hinomi could not match to a repo: exposure is unknown. */
  unmapped: boolean
  /** Deployed from an image with no git source, covered by the later image scan. */
  imageOnly: boolean
  stopped: boolean
  blind: boolean
  open: number
  heat: HeatLevel
}

export function deploymentFacts(d: DeploymentItem): DeploymentFacts {
  const unmapped = needsRepo(d)
  const imageOnly = d.coverage.imageOnly && d.repos.length === 0
  const stopped = deploymentStatus(d.status).tone === 'off'
  return {
    unmapped,
    imageOnly,
    stopped,
    blind: !unmapped && d.openBlindSpots > 0,
    open: openTotal(d),
    heat: unmapped || imageOnly || stopped ? 0 : heatLevel(d.exposed),
  }
}

const byName = (a: DeploymentItem, b: DeploymentItem) => a.name.localeCompare(b.name)

/** Most exposed first, then most open findings, then by name. */
export function byExposure(a: DeploymentItem, b: DeploymentItem): number {
  return b.exposed - a.exposed || openTotal(b) - openTotal(a) || byName(a, b)
}

export interface ServerGroup {
  /** Server name, or null when the source did not report one. */
  server: string | null
  /** "public edge" when any app on it has a public domain, else "internal network". */
  role: string
  items: DeploymentItem[]
  exposed: number
}

/**
 * Apps grouped by the server they run on. Servers with public apps come first, then by
 * exposed findings; an unknown server goes last. Inside a server, most exposed first.
 */
export function groupByServer(items: readonly DeploymentItem[]): ServerGroup[] {
  const groups = new Map<string | null, DeploymentItem[]>()
  for (const d of items) {
    const list = groups.get(d.server) ?? []
    list.push(d)
    groups.set(d.server, list)
  }
  const isPublic = (g: ServerGroup) => g.items.some((d) => d.reach === 'public')
  return [...groups.entries()]
    .map(([server, list]) => {
      const group = {
        server,
        role: 'internal network',
        items: [...list].sort(byExposure),
        exposed: list.reduce((n, d) => n + d.exposed, 0),
      }
      if (isPublic(group)) group.role = 'public edge'
      return group
    })
    .sort(
      (a, b) =>
        Number(a.server === null) - Number(b.server === null) ||
        Number(isPublic(b)) - Number(isPublic(a)) ||
        b.exposed - a.exposed ||
        (a.server ?? '').localeCompare(b.server ?? ''),
    )
}

export const SERVER_UNKNOWN = 'Unknown server'

/** Compares dotted versions number by number ("1.10.0" after "1.9.3"); text parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/)
  const pb = b.split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    const diff = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y, 'en')
    if (diff !== 0) return diff
  }
  return 0
}

export interface Bump {
  packageName: string
  /** The version that patches every patched finding of the package, null with no patch yet. */
  to: string | null
  /** Exposed findings that bump clears. */
  clears: number
  /** Exposed findings of the package with no patched version yet. */
  waiting: number
}

/**
 * The single package bumps that clear the most exposed findings on one app: exposed advisories
 * grouped by package, bumped to the highest first patched version among them. Packages with no
 * patch yet stay in the list after the ones that can be bumped, never hidden.
 */
export function bumpsThatClear(findings: readonly FindingListItem[]): Bump[] {
  const byPackage = new Map<string, Bump>()
  for (const f of findings) {
    if (f.kind !== 'advisory' || f.tier !== 'exposed' || !f.advisory) continue
    const name = f.advisory.packageName
    const patched = f.advisory.firstPatchedVersion
    const bump = byPackage.get(name) ?? { packageName: name, to: null, clears: 0, waiting: 0 }
    if (patched === null) {
      bump.waiting += 1
    } else {
      bump.clears += 1
      if (bump.to === null || compareVersions(patched, bump.to) > 0) bump.to = patched
    }
    byPackage.set(name, bump)
  }
  return [...byPackage.values()].sort(
    (a, b) =>
      b.clears - a.clears || b.waiting - a.waiting || a.packageName.localeCompare(b.packageName),
  )
}
