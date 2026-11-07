import {
  GUARD_CHECKS,
  GUARD_COPY,
  type ContainerSignalSource,
  type FindingListItem,
  type GuardCapability,
  type GuardCheck,
  type GuardEvidence,
  type GuardLevel,
  type GuardResult,
  type MountSource,
  type NetworkBasis,
  type OverridableCheck,
  type OverviewResponse,
  type Runtime,
  type RuntimePinSource,
  type SourceKind,
  type SupportLine,
} from '@hinomi/shared'
import { BLIND_SPOT_INFO, formatDate } from './finding-meta'

/**
 * Words for guard findings, shared by the lists, the finding pane, the deployment panel and the
 * checks page. Titles, explanations and fix texts come from GUARD_COPY (packages/shared), so the
 * web and the notifications say the same thing.
 */

export const GUARD_LEVEL_LABEL: Record<GuardLevel, string> = {
  fail: 'Fail',
  warn: 'Warn',
  unknown: 'Unknown',
}

export const GUARD_RESULT_LABEL: Record<GuardResult, string> = {
  pass: 'Pass',
  ...GUARD_LEVEL_LABEL,
}

/** Worst first, the order counts and filters list levels in. */
export const GUARD_LEVELS_WORST_FIRST: readonly GuardLevel[] = ['fail', 'warn', 'unknown']

/** Checks whose subject is the repo (pins live in the repo); the others are about a deployment. */
const REPO_CHECKS: ReadonlySet<GuardCheck> = new Set([
  'runtime_support',
  'runtime_pins_disagree',
  'action_runtime',
])

export function isRepoCheck(check: GuardCheck): boolean {
  return REPO_CHECKS.has(check)
}

function isGuardCheck(check: OverridableCheck): check is GuardCheck {
  return (GUARD_CHECKS as readonly string[]).includes(check)
}

/** Title of any check that can be turned off: a guard check or a blind spot type. */
export function checkTitle(check: OverridableCheck): string {
  return isGuardCheck(check) ? GUARD_COPY[check].title : BLIND_SPOT_INFO[check].title
}

export const CAPABILITY_LABEL: Record<GuardCapability, string> = {
  full: 'Full',
  partial: 'Partial',
  unknown: 'Cannot tell',
}

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  coolify: 'Coolify',
  github: 'GitHub',
  osv: 'OSV.dev',
}

const CONTAINER_SOURCE: Record<ContainerSignalSource, string> = {
  docker_inspect: 'Docker inspect',
  run_options: 'run options',
  compose: 'compose file',
  dockerfile: 'Dockerfile',
  none: 'no source',
}

export const MOUNT_SOURCE_LABEL: Record<MountSource, string> = {
  docker_inspect: 'Docker inspect',
  run_options: 'Run options',
  compose: 'Compose file',
  file_storage: 'File storage',
  persistent_storage: 'Persistent storage',
}

export const NETWORK_BASIS_LABEL: Record<NetworkBasis, string> = {
  coolify_destination: 'Same Coolify destination',
  external_network: 'Same external network',
  docker_network: 'Same Docker network',
  host_network: 'Host network',
}

export const RUNTIME_LABEL: Record<Runtime, string> = { node: 'Node', bun: 'Bun', rust: 'Rust' }

export const PIN_SOURCE_LABEL: Record<RuntimePinSource, string> = {
  nvmrc: '.nvmrc',
  node_version: '.node-version',
  bun_version: '.bun-version',
  tool_versions: '.tool-versions',
  mise: 'mise.toml',
  volta: 'volta',
  engines: 'engines',
  dev_engines: 'devEngines',
  package_manager: 'packageManager',
  rust_toolchain: 'rust-toolchain',
  cargo_rust_version: 'Cargo rust-version',
  dockerfile: 'Dockerfile FROM',
  setup_node: 'setup-node',
  setup_bun: 'setup-bun',
  rust_toolchain_action: 'toolchain action',
  action_runs_using: 'runs.using',
}

/** "apps/api/Dockerfile:31", or the path alone without a line. */
export function fileAt(path: string, line: number | null): string {
  return line ? `${path}:${line}` : path
}

/** "ended 3 Jan 2026", "ends 1 Mar 2027 (in 84 days)", "no end date". */
export function supportDate(support: SupportLine): string {
  if (!support.eolFrom) return support.isEol ? 'end of life' : 'no end date announced'
  const date = formatDate(support.eolFrom)
  const left = support.daysLeft
  if (left !== null && left < 0) return `ended ${date}`
  if (left !== null) return `ends ${date} (in ${left} day${left === 1 ? '' : 's'})`
  return support.isEol ? `ended ${date}` : `ends ${date}`
}

const worst = (results: readonly GuardResult[]): GuardResult => {
  for (const r of ['fail', 'warn', 'unknown'] as const) if (results.includes(r)) return r
  return 'pass'
}

/**
 * The evidence in one line, for list rows and the deployment panel: where the signal came from
 * ("from Dockerfile line 31"). Unknown evidence says why.
 */
export function evidenceSummary(evidence: GuardEvidence, level?: GuardResult | null): string {
  if (level === 'unknown' && evidence.reason) return evidence.reason
  switch (evidence.check) {
    case 'root_user': {
      if (evidence.services.length) {
        const bad = evidence.services.filter((s) => s.result === 'fail' || s.result === 'warn')
        if (bad.length) return `${bad.map((s) => s.name).join(', ')} without a non root user`
        return `${evidence.services.length} compose services checked`
      }
      if (evidence.source === 'none') return evidence.reason ?? 'No source reports the user'
      const where =
        evidence.source === 'dockerfile' && evidence.line
          ? `Dockerfile line ${evidence.line}`
          : CONTAINER_SOURCE[evidence.source]
      if (evidence.user === null) return `No USER set, from ${where}`
      return `User ${evidence.user === '' ? 'root' : evidence.user}, from ${where}`
    }
    case 'docker_socket': {
      const mount = evidence.mounts[0]
      if (!mount) {
        return evidence.checked.length
          ? `No socket mount in ${evidence.checked.map((s) => MOUNT_SOURCE_LABEL[s].toLowerCase()).join(', ')}`
          : (evidence.reason ?? 'No mounts read')
      }
      const more = evidence.mounts.length > 1 ? ` and ${evidence.mounts.length - 1} more` : ''
      return `${mount.hostPath} mounted, from ${MOUNT_SOURCE_LABEL[mount.source].toLowerCase()}${more}`
    }
    case 'shared_network': {
      const peers = evidence.peers
      if (!peers.length) return evidence.reason ?? 'No other project on its network'
      const db = peers.find((p) => p.database)
      const first = db ?? peers[0]!
      const more = peers.length > 1 ? ` and ${peers.length - 1} more` : ''
      return `Shares a network with ${first.name}${first.database ? ' (database)' : ''}${more}`
    }
    case 'watch_paths_skip':
      if (evidence.autoDeploy === false) return 'Auto deploy is off'
      if (evidence.skipped.length) return `Skips ${evidence.skipped.join(', ')}`
      return evidence.reason ?? `${evidence.checked.length} files trigger a deploy`
    case 'framework_support': {
      const bad =
        evidence.frameworks.find(
          (f) => f.result === worst(evidence.frameworks.map((x) => x.result)),
        ) ?? evidence.frameworks[0]
      if (!bad) return evidence.reason ?? 'No framework matched'
      const when = bad.support ? `, ${supportDate(bad.support)}` : ''
      return `${bad.packageName} ${bad.installedVersion}${when}`
    }
    case 'runtime_support': {
      const entry =
        evidence.runtimes.find((r) => r.result === worst(evidence.runtimes.map((x) => x.result))) ??
        evidence.runtimes[0]
      if (!entry) return evidence.reason ?? 'No runtime pin found'
      const line = entry.support?.line ?? entry.pin?.lineName ?? entry.resolvedTo ?? '?'
      const from = entry.pin ? ` from ${entry.pin.path}` : ''
      const when = entry.support ? `, ${supportDate(entry.support)}` : ''
      return `${RUNTIME_LABEL[entry.runtime]} ${line}${from}${when}`
    }
    case 'runtime_pins_disagree': {
      const entry = evidence.runtimes.find((r) => r.result !== 'pass') ?? evidence.runtimes[0]
      if (!entry) return evidence.reason ?? 'No pins found'
      const lines = [
        ...new Set(entry.pins.filter((p) => !p.floating && p.lineName).map((p) => p.lineName)),
      ]
      return `${RUNTIME_LABEL[entry.runtime]} pinned to ${lines.join(', ')}`
    }
    case 'action_runtime': {
      const bad = evidence.actions.filter((a) => a.result === 'fail' || a.result === 'warn')
      const first = bad[0] ?? evidence.actions[0]
      if (!first) return evidence.reason ?? 'No actions found'
      const more = bad.length > 1 ? ` and ${bad.length - 1} more` : ''
      return `${first.action} runs ${first.using}${more}`
    }
  }
}

/** What a guard finding is on: the deployment for deployment checks, the repo for repo checks. */
export function guardSubject(item: Pick<FindingListItem, 'guard' | 'repo' | 'deployments'>) {
  const repoFirst = item.guard ? isRepoCheck(item.guard.check) : false
  const deployment = item.deployments[0]?.name
  const repo = item.repo?.fullName
  return (repoFirst ? (repo ?? deployment) : (deployment ?? repo)) ?? 'Unknown'
}

export interface GuardCountRow {
  check: GuardCheck
  title: string
  counts: Record<GuardLevel, number>
  total: number
}

/** The overview's guard counts as rows, worst first (fail, then warn, then unknown), zeros left out. */
export function guardCountRows(counts: OverviewResponse['guardCounts']): GuardCountRow[] {
  return GUARD_CHECKS.map((check) => {
    const c = counts[check] ?? {}
    const row = { fail: c.fail ?? 0, warn: c.warn ?? 0, unknown: c.unknown ?? 0 }
    return {
      check,
      title: GUARD_COPY[check].title,
      counts: row,
      total: row.fail + row.warn + row.unknown,
    }
  })
    .filter((r) => r.total > 0)
    .sort(
      (a, b) => b.counts.fail - a.counts.fail || b.counts.warn - a.counts.warn || b.total - a.total,
    )
}

/** Total per level over every check. */
export function guardLevelTotals(
  counts: OverviewResponse['guardCounts'],
): Record<GuardLevel, number> {
  const out = { fail: 0, warn: 0, unknown: 0 }
  for (const check of GUARD_CHECKS) {
    for (const level of GUARD_LEVELS_WORST_FIRST) out[level] += counts[check]?.[level] ?? 0
  }
  return out
}

/**
 * Splits copy with `backtick` spans into text and code parts, so fix texts render their commands
 * as code without a markdown library.
 */
export function codeParts(text: string): { code: boolean; text: string }[] {
  return text
    .split('`')
    .map((part, i) => ({ code: i % 2 === 1, text: part }))
    .filter((p) => p.text !== '')
}
