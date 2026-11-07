import type {
  BlindSpotType,
  CoverageNoteType,
  DeploymentItem,
  DeploymentReach,
  ExposureFactorsDto,
  FindingDetail,
  FindingEvent,
  FindingListItem,
  FindingScope,
  FindingState,
  FindingTier,
  Reporter,
} from '@hinomi/shared'
import { nowMs } from '@hinomi/shared'

/**
 * Words for the finding model, shared by every view so a tier, state or blind spot reads the
 * same on the overview, in the alerts table and on a detail page.
 */

export type SeverityKey = ExposureFactorsDto['severity']

export const SEVERITIES: readonly SeverityKey[] = ['critical', 'high', 'moderate', 'low']

export const SEVERITY_LABEL: Record<SeverityKey, string> = {
  critical: 'Critical',
  high: 'High',
  moderate: 'Moderate',
  low: 'Low',
}

export const TIER_INFO: Record<FindingTier, { name: string; hint: string; number: number }> = {
  blind_spot: {
    name: 'Blind spots',
    hint: 'Deployed repos Hinomi cannot fully see into. Ranked like a critical.',
    number: 0,
  },
  exposed: {
    name: 'Exposed on a public app',
    hint: 'Critical or high, runtime code, on an app with a public domain.',
    number: 1,
  },
  internal: {
    name: 'Deployed, internal only',
    hint: 'Runtime code in an app with no public domain. Reachable from your network or a compromised neighbour.',
    number: 2,
  },
  released: {
    name: 'Released desktop apps',
    hint: "Runtime code in the latest release of an app people install. No deployment, but it is in users' hands.",
    number: 3,
  },
  public_low: {
    name: 'Deployed and public, moderate or low',
    hint: 'Runtime code on a public app, below the alert threshold.',
    number: 4,
  },
  dev: {
    name: 'Deployed, dev dependencies only',
    hint: 'Build and test tooling. Not in the running image unless the Dockerfile copies it.',
    number: 5,
  },
  not_deployed: {
    name: 'Not deployed anywhere',
    hint: 'Repos with no matching deployment. Lowest rank, still listed.',
    number: 6,
  },
  patched: {
    name: 'Patched in the lockfile',
    hint: 'GitHub still lists the alert, but every version in the lockfile is already patched. Dismiss it on GitHub or wait for GitHub to close it.',
    number: 0,
  },
  coverage: {
    name: 'Coverage notes',
    hint: 'Apps deployed from an image with no git source, and guard checks a source cannot answer (level unknown). Not blind spots: ranked last, never alerted.',
    number: 0,
  },
}

/** "Tier 2: Deployed, internal only", or just the name for blind spots. */
export function tierTitle(tier: FindingTier): string {
  const info = TIER_INFO[tier]
  return info.number === 0 ? info.name : `Tier ${info.number}: ${info.name}`
}

export const BLIND_SPOT_INFO: Record<
  BlindSpotType,
  { title: string; short: string; explain: string; fix: readonly [string, string][] }
> = {
  alerts_disabled: {
    title: 'Dependabot alerts are switched off for a deployed repo',
    short: 'No GitHub alerts',
    explain:
      'GitHub reports nothing for this repo, even though it runs in a deployment. A critical here would never reach you through GitHub.',
    fix: [
      ['Open the repo security settings on GitHub', 'Settings, Code security, Dependabot alerts.'],
      ['Enable Dependabot alerts', 'Security updates are optional. Hinomi only needs the alerts.'],
      [
        'Rescan',
        'The blind spot closes on the next scan. OSV keeps scanning the lockfile either way.',
      ],
    ],
  },
  alerts_unknown: {
    title: 'Hinomi cannot tell whether Dependabot alerts are on',
    short: 'Alerts unknown',
    explain:
      'The GitHub token may not read the Dependabot setting of this repo, so a missing alert could mean nothing is wrong or that alerts are off.',
    fix: [
      [
        'Give the token access to the repo',
        'A fine-grained token needs Dependabot alerts read access on it.',
      ],
      ['Rescan', 'The blind spot closes once Hinomi can read the setting.'],
    ],
  },
  archived_deployed: {
    title: 'An archived repo is still deployed',
    short: 'Archived',
    explain: 'The repo no longer gets security updates or alerts, yet a deployment still runs it.',
    fix: [
      [
        'Unarchive the repo, or stop the deployment',
        'An archived repo cannot take a fix pull request.',
      ],
      ['Rescan', 'The blind spot closes on the next scan.'],
    ],
  },
  no_repo_mapping: {
    title: 'A deployment has no repo',
    short: 'No repo matched',
    explain:
      'The deployment runs an image with no git source, so Hinomi cannot read its alerts or lockfile and its exposure is unknown.',
    fix: [
      [
        'Map the repo it is built from',
        'Add a repo override on the deployment page. Monorepos can map several.',
      ],
      ['Rescan', 'Blind spots follow the mapping on the next scan.'],
    ],
  },
  lockfile_missing: {
    title: 'No lockfile in a deployed repo',
    short: 'No lockfile',
    explain:
      'Without a committed lockfile the OSV scan cannot see the exact versions that run, so only GitHub alerts cover this repo.',
    fix: [
      [
        'Commit the lockfile',
        'The lockfile of your package manager, such as package-lock.json, pnpm-lock.yaml, Cargo.lock, go.mod, composer.lock, uv.lock or Gemfile.lock.',
      ],
      ['Rescan', 'The blind spot closes on the next scan.'],
    ],
  },
  lockfile_unparseable: {
    title: 'The lockfile of a deployed repo could not be read',
    short: 'Lockfile unreadable',
    explain:
      'A lockfile was found but its format is not one Hinomi can parse, so the OSV scan skips it.',
    fix: [
      ['Check the lockfile format', 'Regenerate it with a current package manager.'],
      ['Rescan', 'The blind spot closes on the next scan.'],
    ],
  },
}

type GapInfo = { title: string; short: string; explain: string; fix: readonly [string, string][] }

export const COVERAGE_NOTE_INFO: Record<CoverageNoteType, GapInfo> = {
  image_only: {
    title: 'Runs an image with no git source',
    short: 'Image only',
    explain:
      'This service or app is deployed from a container image, not built from a repo, so there is no repo to map and no lockfile to read. It is not a blind spot: the image scan (phase 2) will check what the image contains.',
    fix: [
      [
        'Nothing to do for now',
        'The image scan in phase 2 covers it. It stays ranked low until then.',
      ],
      [
        'Built from a repo you own?',
        'Add a repo override on the deployment page: its alerts and lockfile then count for this deployment.',
      ],
    ],
  },
  release_lockfile_missing: {
    title: 'Release has no lockfile Hinomi reads',
    short: 'Release without lockfile',
    explain:
      "The latest release tag of this desktop app has no lockfile Hinomi can read, so the versions in users' hands are not checked.",
    fix: [
      ['Commit a lockfile', 'Commit the lockfile so the next release tag carries it.'],
      [
        'Not an installable app?',
        'Turn the release tier off for this repo so it is not treated as released.',
      ],
    ],
  },
  requirements_unpinned: {
    title: 'Requirements without exact versions',
    short: 'Unpinned requirements',
    explain:
      'Some lines in requirements.txt name no exact version (ranges, URLs or editable installs), so Hinomi cannot tell which version is installed and does not check them.',
    fix: [['Pin the versions', 'Use name==version, or a lockfile such as uv.lock or poetry.lock.']],
  },
}

/** What a blind spot or a coverage note is about; null for advisories. */
export function gapInfo(
  item: Pick<FindingListItem, 'kind' | 'blindSpotType' | 'coverageNote'>,
): GapInfo | null {
  if (item.kind === 'coverage_note') return COVERAGE_NOTE_INFO[item.coverageNote ?? 'image_only']
  return item.kind === 'blind_spot' && item.blindSpotType
    ? BLIND_SPOT_INFO[item.blindSpotType]
    : null
}

export const SOURCE_LABEL: Record<Reporter, string> = {
  github: 'GitHub',
  osv: 'OSV',
  image: 'Image scan',
}

export function sourcesLabel(sources: readonly Reporter[]): string {
  if (sources.length === 0) return 'Hinomi'
  return sources.map((s) => SOURCE_LABEL[s]).join(' + ')
}

export function sourcesTitle(sources: readonly Reporter[]): string {
  if (sources.length === 0) return 'Found by Hinomi from the coverage of the repo'
  if (sources.length > 1) return 'Reported by GitHub and by the OSV lockfile scan'
  return sources[0] === 'osv'
    ? 'Reported by the OSV lockfile scan only. GitHub did not report this'
    : 'Reported by GitHub only. The OSV lockfile scan did not match it'
}

export const SCOPE_LABEL: Record<FindingScope, string> = {
  runtime: 'Runtime',
  dev: 'Dev',
  unknown: 'Unknown',
}

export const REACH_LABEL: Record<DeploymentReach, string> = {
  public: 'Public',
  internal: 'Internal',
  unknown: 'Unknown reach',
}

/** Snoozed, accepted and upstream dismissed findings stay listed, drawn as decided. */
export function isDecided(state: FindingState): boolean {
  return state === 'snoozed' || state === 'accepted' || state === 'dismissed_upstream'
}

const FACTOR_NAMES = ['Critical or high', 'Runtime dependency', 'Deployed', 'Public'] as const

/**
 * Which of the four rank factors are on; blind spots and coverage notes have unknown severity and
 * runtime. For a guard, runtime means the deployment runs, and an unknown level has no severity.
 */
export function factorFlags(item: Pick<FindingListItem, 'kind' | 'factors' | 'guard'>) {
  const { factors } = item
  if (item.kind === 'guard') {
    const severe = factors.severity === 'critical' || factors.severity === 'high'
    return [
      item.guard?.level === 'unknown' ? null : severe,
      factors.runtime,
      factors.deployed,
      factors.public,
    ] as const
  }
  if (item.kind !== 'advisory') {
    return [null, null, factors.deployed, factors.public] as const
  }
  return [
    factors.severity === 'critical' || factors.severity === 'high',
    factors.runtime,
    factors.deployed,
    factors.public,
  ] as const
}

export function factorsText(flags: readonly (boolean | null)[]): string {
  if (flags[0] === null) {
    const rest = [flags[2] ? 'deployed' : 'not deployed', flags[3] ? 'public' : 'not public']
    return `Severity and runtime unknown, ${rest.join(', ')}`
  }
  const on = FACTOR_NAMES.filter((_, i) => flags[i])
  return on.length ? on.join(', ') : 'No exposure factors'
}

/** Package and advisory, or the blind spot or coverage note, in one line. */
export function findingTitle(item: FindingListItem): string {
  if (item.kind === 'guard') return item.guard?.title ?? 'Guard check'
  if (item.kind !== 'advisory') return gapInfo(item)?.title ?? 'Blind spot'
  return item.advisory?.summary ?? item.advisory?.advisoryKey ?? 'Advisory'
}

/** What the blind spot is on: the repo, or the deployment when there is no repo. */
export function blindSpotSubject(item: FindingListItem): string {
  return item.repo?.fullName ?? item.deployments[0]?.name ?? 'Unknown'
}

/** "shop.example.dev" from "https://shop.example.dev/". */
export function displayDomain(domain: string): string {
  return domain.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')
}

export function domainHref(domain: string): string {
  return /^[a-z]+:\/\//i.test(domain) ? domain : `https://${domain}`
}

/** Coolify reports "running:healthy", "exited:unhealthy" and the like. */
export function deploymentStatus(status: string | null): {
  label: string
  tone: 'ok' | 'off' | 'unknown'
} {
  if (!status) return { label: 'Unknown', tone: 'unknown' }
  const head = status.split(':')[0]?.toLowerCase() ?? ''
  if (head === 'running') return { label: 'Running', tone: 'ok' }
  if (head === 'exited' || head === 'stopped') return { label: 'Exited', tone: 'off' }
  return { label: head.charAt(0).toUpperCase() + head.slice(1), tone: 'unknown' }
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** "4 Dec 2026". */
export function formatDate(iso: string): string {
  const then = Date.parse(iso)
  return Number.isNaN(then) ? iso : dateFormat.format(then)
}

/** "4 Dec, 14:02". */
export function formatDateTime(iso: string): string {
  const then = Date.parse(iso)
  return Number.isNaN(then) ? iso : dateTimeFormat.format(then)
}

/** Compact age for table cells: "3d", "5h", "2mo". */
export function formatAge(iso: string, now: number = nowMs()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 60) return `${days}d`
  const months = Math.round(days / 30)
  return months < 24 ? `${months}mo` : `${Math.round(days / 365)}y`
}

/** Snoozed or accepted wording with the expiry, for rows and banners. */
export function decisionLabel(
  item: Pick<FindingListItem, 'state' | 'stateUntil'> &
    Partial<Pick<FindingListItem, 'stateUntilNewAdvisory'>>,
): string | null {
  const until = item.stateUntilNewAdvisory
    ? ' until a new advisory'
    : item.stateUntil
      ? ` until ${formatDate(item.stateUntil)}`
      : ''
  if (item.state === 'snoozed') return `Snoozed${until}`
  if (item.state === 'accepted') return `Risk accepted${until}`
  if (item.state === 'dismissed_upstream') return 'Dismissed on GitHub'
  return null
}

/** One sentence per history event. */
export function eventSentence(event: FindingEvent): string {
  const by = event.actor === 'user' ? 'by you' : ''
  const until = event.untilNewAdvisory
    ? ' until a new advisory'
    : event.until
      ? ` until ${formatDate(event.until)}`
      : ''
  switch (event.type) {
    case 'opened':
      return 'First seen by a scan'
    case 'snoozed':
      return `Snoozed ${by}${until}`.replace(/\s+/g, ' ')
    case 'accepted':
      return `Risk accepted ${by}${until}`.replace(/\s+/g, ' ')
    case 'reopened':
      return event.actor === 'user' ? 'Decision removed by you, open again' : 'Came back in a scan'
    case 'snooze_expired':
      return 'Snooze expired, back in the ranking'
    case 'acceptance_expired':
      return 'Accepted risk expired, back in the ranking'
    case 'fixed':
      return 'No source reports it anymore, marked fixed'
    case 'resolved':
      return 'Coverage is back, blind spot closed'
    case 'dismissed_upstream':
      return 'Dismissed on GitHub, no other source reports it'
    case 'dismissal_noted':
      return 'Dismissed on GitHub, but OSV still reports it'
    case 'reporters_changed':
      return 'The sources reporting it changed'
    case 'escalated':
      return 'The level got worse'
    case 'level_changed':
      return 'The level got better'
    case 'turned_off':
      return event.actor === 'user' ? 'Check turned off by you' : 'Check turned off'
    default:
      return event.type.replaceAll('_', ' ')
  }
}

/** A deployment that should map to a repo but does not (databases and image only ones need none). */
export function needsRepo(d: Pick<DeploymentItem, 'kind' | 'repos' | 'coverage'>): boolean {
  return d.kind !== 'database' && d.repos.length === 0 && !d.coverage.imageOnly
}

export function repoLabel(d: DeploymentItem): string | null {
  if (d.repos.length === 0) return null
  return d.repos.map((r) => r.fullName).join(', ')
}

/** Definitions behind the counting words, shown on hover and focus. */
export const TERMS = {
  exposed:
    'Exposed: a critical or high advisory in runtime code on an app with a public domain, not yet fixed.',
  needsAction: 'Needs action: exposed, with no snooze or accepted risk in force.',
  blindSpot:
    'Blind spot: a deployed repo Hinomi cannot fully see into, for example Dependabot alerts switched off. Ranked like a critical.',
} as const

/** Where repo overrides are edited: the Repo mapping section of Settings. */
export const MAPPING_SETTINGS = { to: '/settings', hash: 'settings-mapping' } as const

/** Shown instead of an installed version no source reported. */
export const VERSION_UNKNOWN = 'version unknown'

export const VERSION_UNKNOWN_HINT =
  'No source reported the installed version. The finding page says why.'

const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'requirements.txt',
  'go.mod',
  'composer.lock',
  'uv.lock',
  'poetry.lock',
  'Gemfile.lock',
]
const isLockfile = (path: string) => LOCKFILE_NAMES.includes(path.slice(path.lastIndexOf('/') + 1))

/**
 * Why an advisory has no installed version. GitHub alerts carry none: it comes from
 * the OSV lockfile scan, so it is missing when no lockfile Hinomi read lists the package.
 */
export function unknownVersionReason(
  f: Pick<FindingDetail, 'sources'> & {
    dependency: Pick<FindingDetail['dependency'], 'manifestPaths'>
  },
): string {
  const manifest = f.dependency.manifestPaths[0]
  if (!f.sources.includes('github') || !manifest) {
    return 'No source reported which version is installed.'
  }
  if (isLockfile(manifest)) {
    return `GitHub reports this alert on ${manifest} without a version, and no lockfile Hinomi read lists the package: the OSV lockfile scan may be off, or the deployed branch has another lockfile.`
  }
  return `GitHub reports this alert on ${manifest}, a manifest without exact versions, and no lockfile Hinomi read lists the package.`
}

/** Repo, then the lockfile or manifest, then the chain down to the vulnerable package. */
export function dependencyPath(f: FindingDetail, packageName: string): string[] {
  const installed = f.versions.installed
    ? `${packageName}@${f.versions.installed}`
    : `${packageName} (${VERSION_UNKNOWN})`
  const chain = f.dependency.path ?? []
  const above = chain.length > 1 && chain.at(-1) === packageName ? chain.slice(0, -1) : []
  return [
    f.repo?.fullName ?? 'repo',
    ...f.dependency.manifestPaths.slice(0, 1),
    ...above,
    installed,
  ]
}

/** The description as plain paragraphs, without a first paragraph that repeats the summary. */
export function descriptionParagraphs(
  description: string | null,
  summary: string | null,
): string[] {
  if (!description) return []
  const parts = description
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s*/gm, '').trim())
    .filter(Boolean)
  if (parts[0] && summary && parts[0] === summary.trim()) parts.shift()
  return parts
}
