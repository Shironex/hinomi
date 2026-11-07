import type { FindingDetail } from '@hinomi/shared'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconBrandGithub,
  IconCheck,
  IconClock,
  IconClockPause,
  IconDatabase,
  IconExternalLink,
  IconGitPullRequest,
  IconLock,
  IconPlugConnected,
  IconPower,
  IconServer2,
  IconWorld,
} from '@tabler/icons-react'
import { eventIcon, eventTone } from '@/components/findings/event-icon'
import { StatusText } from '@/components/findings/finding-state'
import { GuardEvidenceView } from '@/components/guards/guard-evidence-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KeyValues } from '@/components/views/panel'
import {
  blindSpotSubject,
  decisionLabel,
  dependencyPath,
  descriptionParagraphs,
  displayDomain,
  eventSentence,
  factorFlags,
  findingTitle,
  formatDate,
  formatDateTime,
  gapInfo,
  SCOPE_LABEL,
  SEVERITY_LABEL,
  sourcesLabel,
  TIER_INFO,
  tierTitle,
  unknownVersionReason,
  VERSION_UNKNOWN,
  VERSION_UNKNOWN_HINT,
} from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { FIXED_ON_MAIN_HINT, FIXED_ON_MAIN_LABEL } from '@/lib/release-meta'
import { codeParts, GUARD_LEVEL_LABEL, guardSubject } from '@/lib/guard-meta'
import { cn } from '@/lib/utils'
import { findingsQuery } from '@/lib/view-api'
import { FixWithHinomi } from '@/components/views/fix-with-hinomi'
import { NO_PLAN_NOTE, type FixRequestRepo } from '@/lib/fix-request'
import { findingName, joinAnd, releaseKind } from '@/lib/triage'
import { FindingBadge } from './triage-row'

const number = new Intl.NumberFormat('en-US')

/** The finding's repo when it has a fix plan, for Fix with Hinomi. */
function planRepos(f: FindingDetail): FixRequestRepo[] {
  return f.repo && f.plan ? [{ id: f.repo.id, fullName: f.repo.fullName }] : []
}

/** A titled block of the detail pane. */
export function PaneSection({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-md">{title}</h2>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** The violet box of the fix, or the cyan one of a blind spot. */
export function FixBox({
  tone = 'fix',
  children,
  className,
}: {
  tone?: 'fix' | 'blind' | 'ok'
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-lg border px-5 py-[18px]',
        tone === 'fix' &&
          'border-[color-mix(in_oklab,var(--primary)_45%,var(--border))] bg-[color-mix(in_oklab,var(--primary)_8%,var(--card))]',
        tone === 'blind' &&
          'border-[color-mix(in_oklab,var(--blind)_45%,var(--border))] bg-[color-mix(in_oklab,var(--blind)_7%,var(--card))]',
        tone === 'ok' && 'border-transparent bg-success-soft',
        className,
      )}
    >
      {children}
    </section>
  )
}

/** "14.2.3 → 14.2.9", the target in the success ink. */
export function Bump({
  from,
  to,
  unknownTitle = VERSION_UNKNOWN_HINT,
  className,
}: {
  from: string | null
  to: string | null
  /** Why the installed version is unknown, on hover. */
  unknownTitle?: string
  className?: string
}) {
  return (
    <span className={cn('font-mono', className)}>
      {from ?? <span title={unknownTitle}>{VERSION_UNKNOWN}</span>}
      {to ? (
        <>
          {' '}
          <span aria-label="patched in">→</span> <b className="font-semibold text-success">{to}</b>
        </>
      ) : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Head

/** Snoozes, expiries and fixes in a few words, for the meta line of the head. */
function stateLine(f: FindingDetail): ReactNode {
  if (f.guard?.override && f.state === 'accepted') {
    return <StatusText icon={IconPower}>Turned off</StatusText>
  }
  const decided = decisionLabel(f)
  if (decided) return <StatusText icon={IconClockPause}>{decided}</StatusText>
  if (f.state === 'fixing') {
    return (
      <StatusText icon={IconGitPullRequest} tone="run">
        Fix in progress
      </StatusText>
    )
  }
  if (f.state === 'fixed') {
    return <StatusText tone="ok">{f.kind === 'advisory' ? 'Fixed' : 'Resolved'}</StatusText>
  }
  const latest = f.history[0]
  if (latest && (latest.type === 'snooze_expired' || latest.type === 'acceptance_expired')) {
    return (
      <StatusText tone="wait">
        {latest.type === 'snooze_expired' ? 'Snooze' : 'Accepted risk'} expired{' '}
        {formatRelative(latest.at)}
      </StatusText>
    )
  }
  return null
}

function reachLine(f: FindingDetail): { icon: typeof IconWorld; text: string } {
  const publicApps = f.deployments.filter((d) => d.reach === 'public')
  if (publicApps.length === 1) {
    const domain = publicApps[0]!.domains[0]
    return {
      icon: IconWorld,
      text: domain ? `${publicApps[0]!.name}, ${displayDomain(domain)}` : publicApps[0]!.name,
    }
  }
  if (publicApps.length > 1) return { icon: IconWorld, text: `${publicApps.length} public apps` }
  if (f.deployments.length > 0) {
    return {
      icon: IconLock,
      text: `${joinAnd(
        f.deployments.map((d) => d.name),
        2,
      )}, internal only`,
    }
  }
  return { icon: IconServer2, text: 'Not deployed' }
}

export interface HeadActions {
  onDefer: (kind: 'snooze' | 'accept') => void
  deferOpen: 'snooze' | 'accept' | null
  /** Guards: opens the turn off dialog, or the override's edit dialog when it is off. */
  onTurnOff?: () => void
}

function githubLabel(url: string): string {
  try {
    return new URL(url).hostname.endsWith('github.com') ? 'Open on GitHub' : 'Open advisory'
  } catch {
    return 'Open advisory'
  }
}

function PrimaryGapAction({ f }: { f: FindingDetail }) {
  const type = f.blindSpotType
  if (f.kind === 'blind_spot' && f.repo && type !== 'no_repo_mapping' && type !== null) {
    const label =
      type === 'alerts_disabled'
        ? 'Turn on Dependabot alerts'
        : type === 'alerts_unknown'
          ? 'Check the repo settings'
          : 'Open the repo on GitHub'
    const href =
      type === 'alerts_disabled' || type === 'alerts_unknown'
        ? `https://github.com/${f.repo.fullName}/settings/security_analysis`
        : `https://github.com/${f.repo.fullName}`
    return (
      <Button asChild>
        <a href={href} target="_blank" rel="noreferrer noopener">
          <IconBrandGithub aria-hidden="true" />
          {label}
        </a>
      </Button>
    )
  }
  const app = f.deployments[0]
  if (app && (type === 'no_repo_mapping' || f.kind === 'coverage_note')) {
    return (
      <Button asChild variant={f.kind === 'coverage_note' ? 'outline' : 'default'}>
        <Link to="/deployments/$id" params={{ id: String(app.id) }}>
          <IconPlugConnected aria-hidden="true" />
          Map a repo
        </Link>
      </Button>
    )
  }
  return null
}

export function FindingHead({
  f,
  big,
  actions,
}: {
  f: FindingDetail
  big: boolean
  actions: HeadActions
}) {
  const a = f.advisory
  const reach = reachLine(f)
  const SourceIcon = f.sources.includes('github') ? IconBrandGithub : IconDatabase
  const canDefer = f.state !== 'fixed'
  const deferButton = (kind: 'snooze' | 'accept', label: string, Icon: typeof IconCheck) => (
    <Button
      variant="outline"
      onClick={() => actions.onDefer(kind)}
      aria-expanded={actions.deferOpen === kind}
      aria-controls="defer-panel"
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  )
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <FindingBadge item={f} />
        <span className="font-mono text-md font-medium">{findingName(f)}</span>
        {f.kind === 'advisory' ? (
          <>
            <Bump
              from={f.versions.installed}
              to={f.versions.firstPatched}
              unknownTitle={unknownVersionReason(f)}
              className="text-xs text-muted-foreground"
            />
            {a?.cvssScore != null ? (
              <span className="text-xs text-muted-foreground">
                CVSS{' '}
                <span className="font-mono text-sm font-semibold text-foreground">
                  {a.cvssScore.toFixed(1)}
                </span>
              </span>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">
              {a?.ghsaId ?? a?.advisoryKey}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {f.kind === 'blind_spot'
              ? 'ranked like a critical'
              : f.kind === 'guard' && f.guard?.level !== 'unknown'
                ? `counts as ${SEVERITY_LABEL[f.factors.severity].toLowerCase()}`
                : 'ranked low'}
          </span>
        )}
      </div>
      <h1 className={cn('max-w-[40ch] leading-[1.25]', big ? 'tab:text-xl' : 'text-lg')}>
        {findingTitle(f)}
      </h1>
      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-sm text-foreground-2">
        <span className="inline-flex items-center gap-1.5">
          <reach.icon
            aria-hidden="true"
            className="size-[15px] text-muted-foreground"
            stroke={1.75}
          />
          {reach.text}
        </span>
        {f.kind === 'advisory' ? (
          <span className="inline-flex items-center gap-1.5">
            <SourceIcon
              aria-hidden="true"
              className="size-[15px] text-muted-foreground"
              stroke={1.75}
            />
            {sourcesLabel(f.sources)}
          </span>
        ) : f.deployments[0]?.server ? (
          <span className="inline-flex items-center gap-1.5">
            <IconServer2
              aria-hidden="true"
              className="size-[15px] text-muted-foreground"
              stroke={1.75}
            />
            {f.deployments[0].server}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <IconClock
            aria-hidden="true"
            className="size-[15px] text-muted-foreground"
            stroke={1.75}
          />
          {f.kind === 'advisory'
            ? `First seen ${formatRelative(f.firstSeenAt)}`
            : `Since ${formatDate(f.firstSeenAt)}`}
        </span>
        {stateLine(f)}
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {f.kind === 'advisory' ? (
          <FixWithHinomi repos={planRepos(f)} findingId={f.id} noteId="fix-agent-note" />
        ) : f.kind === 'guard' ? (
          actions.onTurnOff && (canDefer || f.guard?.override) ? (
            <Button variant="outline" onClick={actions.onTurnOff} aria-haspopup="dialog">
              <IconPower aria-hidden="true" />
              {f.guard?.override ? 'Turned off, edit' : 'Turn off'}
            </Button>
          ) : null
        ) : (
          <PrimaryGapAction f={f} />
        )}
        {canDefer && !f.guard?.override ? deferButton('snooze', 'Snooze', IconClockPause) : null}
        {canDefer && !f.guard?.override
          ? deferButton(
              'accept',
              f.kind === 'advisory' || f.kind === 'guard' ? 'Accept risk' : 'Accept the gap',
              IconCheck,
            )
          : null}
        {a?.url ? (
          <Button asChild variant="outline">
            <a href={a.url} target="_blank" rel="noreferrer noopener">
              <IconExternalLink aria-hidden="true" />
              {githubLabel(a.url)}
            </a>
          </Button>
        ) : null}
      </div>
      {f.kind === 'advisory' && !f.plan ? (
        <span id="fix-agent-note" className="sr-only">
          {NO_PLAN_NOTE}
        </span>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Why it ranks

/** "network" from a CVSS vector's AV part. */
function attackVector(vector: string | null): string | null {
  const av = vector?.match(/AV:([NALP])/)?.[1]
  if (!av) return null
  return { N: 'network', A: 'adjacent network', L: 'local', P: 'physical' }[av] ?? null
}

function severityText(f: FindingDetail): string {
  if (f.kind === 'guard' && f.guard) {
    if (f.guard.level === 'unknown') return 'Unknown: the source cannot give this signal'
    return `${GUARD_LEVEL_LABEL[f.guard.level]}, counts as ${SEVERITY_LABEL[f.factors.severity].toLowerCase()}`
  }
  if (f.kind === 'coverage_note') return 'Unknown until the image scan reads it'
  if (f.kind === 'blind_spot') {
    return f.blindSpotType === 'alerts_disabled'
      ? 'Unknown: GitHub sends nothing for this repo'
      : `Unknown: ${(gapInfo(f)?.short ?? 'no coverage').toLowerCase()}`
  }
  if (f.unscored) return 'Unscored, ranked as moderate'
  const vector = f.advisory?.cvssVector ?? null
  return [
    SEVERITY_LABEL[f.factors.severity],
    f.advisory?.cvssScore != null ? `CVSS ${f.advisory.cvssScore.toFixed(1)}` : null,
    attackVector(vector),
    vector?.includes('PR:N') ? 'no privileges needed' : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function runtimeText(f: FindingDetail): string {
  if (f.kind === 'guard') {
    if (!f.deployments.length) return 'Nothing runs it'
    return f.stopped
      ? 'Every deployment is stopped'
      : `${joinAnd(f.deployments.map((d) => d.name))} runs`
  }
  if (f.kind === 'coverage_note') return 'Unknown without a repo or lockfile'
  if (f.kind === 'blind_spot') {
    return f.blindSpotType?.startsWith('alerts') ? 'Unknown without alerts' : 'Unknown'
  }
  if (f.scope === 'dev') return 'Dev dependency: build and test tooling'
  if (f.scope === 'unknown') return 'Dependency scope unknown'
  const apps = f.deployments.map((d) => d.name)
  if (apps.length) return `In dependencies of ${joinAnd(apps)}, not dev tooling`
  return `Runtime dependency${f.repo ? ` of ${f.repo.fullName}` : ''}`
}

function deployedText(f: FindingDetail): string {
  if (!f.deployments.length) return 'No deployment runs this repo'
  const servers = [...new Set(f.deployments.map((d) => d.server ?? d.name))]
  return `${f.stopped ? 'Stopped' : 'Running'} on ${joinAnd(servers)}`
}

function publicText(f: FindingDetail): string {
  const domains = f.deployments
    .filter((d) => d.reach === 'public')
    .flatMap((d) => d.domains.map(displayDomain))
  if (domains.length) return `Reachable at ${joinAnd(domains)}`
  if (f.deployments.length) return 'No public domain; reachable from your network only'
  return 'No deployment, so no domain'
}

const FACTOR_WORD = { true: 'on', false: 'off', null: 'unknown' } as const

function FactorBox({ on }: { on: boolean | null }) {
  return (
    <span
      className={cn(
        'grid size-[22px] shrink-0 place-items-center rounded-sm',
        on === null &&
          'bg-[repeating-linear-gradient(135deg,var(--blind)_0_1.5px,transparent_1.5px_4px)] shadow-[inset_0_0_0_1px_var(--blind)]',
        on === true && 'bg-muted text-foreground',
        on === false && 'shadow-[inset_0_0_0_1px_var(--input)]',
      )}
    >
      {on ? <IconCheck aria-hidden="true" className="size-3.5" stroke={2.4} /> : null}
      <span className="sr-only">{FACTOR_WORD[String(on) as 'true' | 'false' | 'null']}</span>
    </span>
  )
}

function whyTitle(f: FindingDetail, rank: number | undefined): string {
  if (f.kind === 'coverage_note' || f.guard?.level === 'unknown') return 'Why it ranks low'
  if (f.kind === 'blind_spot') return 'Why it ranks like a critical'
  if (f.patchedInLockfile) return 'Why it ranks below every open advisory'
  if (rank !== undefined) return `Why it ranks #${rank}`
  if (f.tier === 'exposed') return 'Why it ranks at the top'
  return 'Why it ranks below the line'
}

export function WhyItRanks({ f, rank }: { f: FindingDetail; rank?: number }) {
  const flags = factorFlags(f)
  const rows: [string, boolean | null, string][] = [
    ['Severity', flags[0], severityText(f)],
    [f.kind === 'guard' ? 'Running' : 'Runtime', flags[1], runtimeText(f)],
    ['Deployed', flags[2], deployedText(f)],
    ['Public', flags[3], publicText(f)],
  ]
  const on = flags.filter((x) => x === true).length
  const top = f.tier === 'exposed' || f.tier === 'blind_spot'
  const aside =
    f.kind !== 'advisory' && f.kind !== 'guard'
      ? undefined
      : on === 4
        ? 'All four exposure factors are on'
        : `${on} of four exposure factors ${on === 1 ? 'is' : 'are'} on${top ? '' : `. ${tierTitle(f.tier)}`}`
  return (
    <PaneSection title={whyTitle(f, rank)} aside={aside}>
      <ul aria-label="Exposure factors" className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">
        {rows.map(([label, value, text]) => (
          <li
            key={label}
            className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-x-3 tab:grid-cols-[22px_110px_minmax(0,1fr)] tab:items-center"
          >
            <FactorBox on={value} />
            <span className="pt-0.5 tab:contents">
              <b className="font-semibold">{label}</b>{' '}
              <span className="text-foreground-2">{text}</span>
            </span>
          </li>
        ))}
      </ul>
    </PaneSection>
  )
}

// ---------------------------------------------------------------------------
// The fix

function FixButtons({ f }: { f: FindingDetail }) {
  return (
    <div className="flex flex-wrap gap-2">
      <FixWithHinomi size="sm" repos={planRepos(f)} findingId={f.id} noteId="fix-agent-note" />
      {f.repo ? (
        <Button asChild size="sm" variant="outline">
          <a
            href={`https://github.com/${f.repo.fullName}/compare`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <IconGitPullRequest aria-hidden="true" />
            Open PR manually
          </a>
        </Button>
      ) : null}
    </div>
  )
}

function clearsText(f: FindingDetail): string {
  const n = f.sameFixClears
  if (n <= 1) return `It clears this finding${f.repo ? ` in ${f.repo.fullName}` : ''}.`
  return `The same bump clears ${number.format(n)} open findings, this one included, across every repo that pins ${f.advisory?.packageName ?? 'the package'} below it.`
}

/**
 * A release finding says which tag it was found in. When the default branch already fixed it, a
 * patched release is due, and the finding stays open until one ships.
 */
function ReleaseNotice({ f }: { f: FindingDetail }) {
  if (!f.releaseTag) return null
  return (
    <FixBox tone={f.fixedOnDefaultBranch ? 'ok' : 'fix'}>
      <h2 className="text-base">
        {f.fixedOnDefaultBranch ? FIXED_ON_MAIN_LABEL : `In the released build ${f.releaseTag}`}
      </h2>
      <p className="max-w-[68ch] text-sm text-foreground-2">
        {f.fixedOnDefaultBranch
          ? `${FIXED_ON_MAIN_HINT} It was found in ${f.releaseTag}.`
          : `Found in the latest release, ${f.releaseTag}, of an app people install. Fixing the default branch is not enough: a new release has to ship the patched version.`}
        {f.repo ? (
          <>
            {' '}
            <Link
              to="/repos/$id"
              params={{ id: String(f.repo.id) }}
              className="text-accent-ink underline-offset-2 hover:underline"
            >
              Release panel for {f.repo.fullName}
            </Link>
          </>
        ) : null}
      </p>
    </FixBox>
  )
}

/** The bump that fixes an advisory and how much it clears; the steps that close a gap. */
export function FixCard({ f, compact = false }: { f: FindingDetail; compact?: boolean }) {
  if (f.releaseTag) {
    return (
      <>
        <ReleaseNotice f={f} />
        <FixCardBody f={f} compact={compact} />
      </>
    )
  }
  return <FixCardBody f={f} compact={compact} />
}

function FixCardBody({ f, compact = false }: { f: FindingDetail; compact?: boolean }) {
  const pkg = f.advisory?.packageName ?? 'the package'
  if (f.kind === 'guard') {
    if (!f.guard?.fixText) return null
    return (
      <FixBox>
        <h2 className="text-base">
          {f.guard.level === 'unknown' ? 'What you can do' : 'How to fix it'}
        </h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-2">
          <CodeText text={f.guard.fixText} />
        </p>
      </FixBox>
    )
  }
  if (f.kind !== 'advisory') {
    const info = gapInfo(f)
    if (!info) return null
    return (
      <FixBox tone="blind">
        <h2 className="text-base">
          {f.kind === 'coverage_note' ? 'What happens next' : 'How to close it'}
        </h2>
        <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm text-foreground-2">
          {info.fix.map(([title, detail], i) => (
            <li key={title} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
              <span className="font-mono text-xs leading-5 text-muted-foreground">{i + 1}</span>
              <span>
                <b className="font-semibold text-foreground">{title}.</b> {detail}
              </span>
            </li>
          ))}
        </ol>
      </FixBox>
    )
  }
  if (f.patchedInLockfile) {
    return (
      <FixBox tone="ok">
        <h2 className="text-base">Already patched in the lockfile</h2>
        <p className="text-sm text-foreground-2">
          {pkg}
          {f.versions.installed ? ` ${f.versions.installed}` : ''} in the lockfile is already
          patched, for example through an override or a resolution. GitHub keeps the alert open
          until it rescans: dismiss it there, or wait for GitHub to close it. It never sends a
          notification, and returns to the ranking if a scan finds a vulnerable version again.
        </p>
      </FixBox>
    )
  }
  if (!f.versions.firstPatched) {
    return (
      <FixBox>
        <h2 className="text-base">No patched version yet</h2>
        <p className="text-sm text-foreground-2">
          No release of {pkg} fixes this. Snooze it until a new advisory, accept the risk with a
          reason, or replace the package.
        </p>
      </FixBox>
    )
  }
  const kind = releaseKind(f.versions.installed, f.versions.firstPatched)
  if (compact) {
    return (
      <FixBox className="gap-2.5 px-4 py-4">
        <h2 className="sr-only">The fix</h2>
        <Bump from={f.versions.installed} to={f.versions.firstPatched} className="text-md" />
        <p className="text-sm text-foreground-2">
          {f.sameFixClears > 1
            ? `Clears ${number.format(f.sameFixClears)} findings`
            : 'Clears this finding'}
          {f.deployments.length > 1 ? ` in ${f.deployments.length} apps` : ''}
        </p>
        <FixWithHinomi
          repos={planRepos(f)}
          findingId={f.id}
          noteId="fix-agent-note"
          className="w-full"
        />
      </FixBox>
    )
  }
  return (
    <FixBox>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base">The fix</h2>
        {kind ? <span className="ml-auto text-xs text-muted-foreground">{kind}</span> : null}
      </div>
      <span className="text-md font-semibold">
        <span className="font-mono">{pkg}</span>{' '}
        <Bump from={f.versions.installed} to={f.versions.firstPatched} />
      </span>
      <p className="text-sm text-foreground-2">
        {clearsText(f)}{' '}
        {f.plan
          ? "Fix with Hinomi runs the repo's whole plan in one pull request, this bump included."
          : NO_PLAN_NOTE}
      </p>
      <FixButtons f={f} />
    </FixBox>
  )
}

// ---------------------------------------------------------------------------
// What a blind spot still lets Hinomi see

export function StillSees({ f }: { f: FindingDetail }) {
  const info = gapInfo(f)
  const alertsOff = f.kind === 'blind_spot' && f.blindSpotType === 'alerts_disabled' && f.repo
  const osv = useQuery({
    ...findingsQuery({ repo: f.repo ? [f.repo.id] : [], kind: ['advisory'], limit: 5 }),
    enabled: Boolean(alertsOff),
  })
  if (f.kind === 'advisory' || !info) return null
  if (!alertsOff) {
    return (
      <PaneSection title="What this means">
        <p className="max-w-[68ch] text-foreground-2">{info.explain}</p>
      </PaneSection>
    )
  }
  const app = f.deployments[0]
  const isPublic = f.deployments.some((d) => d.reach === 'public')
  const found = osv.data?.total ?? 0
  return (
    <PaneSection title="What Hinomi can still see">
      <p className="max-w-[68ch] text-foreground-2">
        {app ? `${app.name} is ${isPublic ? 'public and ' : ''}running` : 'The repo is deployed'},
        but GitHub sends no alerts for its repo, so Hinomi only sees what the OSV.dev lockfile scan
        finds.
        {osv.data
          ? found
            ? ` OSV found ${number.format(found)} open advisor${found === 1 ? 'y' : 'ies'} that GitHub did not report.`
            : ' OSV found no open advisory in its lockfile.'
          : ''}
      </p>
      {osv.data?.items.length ? (
        <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0">
          {osv.data.items.map((item) => (
            <li key={item.id} className="border-t border-border first:border-t-0">
              <Link
                to="/finding/$id"
                params={{ id: String(item.id) }}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-5 py-3 text-inherit no-underline hover:bg-muted"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <FindingBadge item={item} />
                  <span className="font-mono font-medium">{findingName(item)}</span>
                  <Bump
                    from={item.installedVersion}
                    to={item.advisory?.firstPatchedVersion ?? null}
                    className="text-xs text-muted-foreground"
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.sources.includes('github') ? sourcesLabel(item.sources) : 'OSV only'}
                </span>
                <span className="col-span-2 truncate text-foreground">{findingTitle(item)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </PaneSection>
  )
}

// ---------------------------------------------------------------------------
// Affected apps, advisory, history, notifications, details

function via(f: FindingDetail): string | null {
  if (f.kind !== 'advisory') return null
  const path = f.dependency.path
  if (!path || f.dependency.pathSource !== 'lockfile') return null
  return path.length <= 1 ? 'direct' : `via ${path[0]}`
}

export function AffectedApps({ f }: { f: FindingDetail }) {
  if (!f.deployments.length) {
    return (
      <PaneSection title="Affected apps" aside="None">
        <p className="text-sm text-muted-foreground">
          No deployment runs{' '}
          {f.repo ? <span className="font-mono">{f.repo.fullName}</span> : 'this'}, so it ranks
          last. Map the repo to a deployment if it does run somewhere.
        </p>
      </PaneSection>
    )
  }
  const manifest = f.dependency.manifestPaths[0]
  const how = via(f)
  return (
    <PaneSection title="Affected apps">
      <ul className="m-0 flex list-none flex-col p-0">
        {f.deployments.map((d) => {
          const Icon = d.reach === 'public' ? IconWorld : IconLock
          const sub = [
            d.domains.map(displayDomain).join(', ') ||
              (d.reach === 'public' ? null : 'Internal only'),
            manifest ? manifest.slice(manifest.lastIndexOf('/') + 1) : null,
            how,
            f.repo?.alertsEnabled === false ? 'alerts off, seen through OSV' : null,
          ].filter(Boolean)
          return (
            <li
              key={d.id}
              className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border py-3 first:border-t-0 first:pt-0"
            >
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" stroke={1.75} />
              <Link
                to="/deployments/$id"
                params={{ id: String(d.id) }}
                className="truncate font-semibold text-foreground hover:underline"
              >
                {d.name}
              </Link>
              {d.server ? <Badge variant="default">{d.server}</Badge> : <span />}
              {sub.length ? (
                <small className="col-start-2 col-end-4 text-xs text-muted-foreground">
                  {sub.join(', ')}
                </small>
              ) : null}
            </li>
          )
        })}
      </ul>
    </PaneSection>
  )
}

const PATH_NOTE: Record<FindingDetail['dependency']['pathSource'], string> = {
  lockfile: 'From the lockfile Hinomi scans: each line is pulled in by the one above it.',
  manifest:
    'Only the manifest is known. The full chain shows once Hinomi parses a lockfile for it.',
  package: 'No manifest or lockfile reported where this package comes from.',
}

const CODE = 'rounded-sm bg-muted px-1.5 py-px font-mono text-[13px] text-foreground'

export function AdvisorySection({ f }: { f: FindingDetail }) {
  const a = f.advisory
  if (!a) return null
  const ranges = f.versions.vulnerableRanges.length
    ? f.versions.vulnerableRanges
    : a.vulnerableRanges
  const path = dependencyPath(f, a.packageName)
  const paragraphs = descriptionParagraphs(a.description, a.summary)
  return (
    <PaneSection title="Advisory">
      <div className="flex max-w-[68ch] flex-col gap-2.5 leading-relaxed text-foreground-2">
        <p>{a.summary ?? 'The advisory has no summary.'}</p>
        {paragraphs.length ? (
          <details
            className="group rounded-md border border-border bg-card"
            open={paragraphs.join('').length < 600}
          >
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Show the full description</span>
              <span className="hidden group-open:inline">Description</span>
            </summary>
            <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto border-t border-border px-3 py-2.5 text-sm break-words">
              {paragraphs.map((text, i) => (
                <p key={i} className="whitespace-pre-line">
                  {text}
                </p>
              ))}
            </div>
          </details>
        ) : null}
        {a.withdrawnAt ? (
          <p className="text-sev-high">Withdrawn {formatDate(a.withdrawnAt)}.</p>
        ) : null}
        <p>
          Vulnerable range{' '}
          {ranges.length
            ? ranges.map((r, i) => (
                <span key={r}>
                  {i > 0 ? ', ' : ''}
                  <code className={CODE}>{r}</code>
                </span>
              ))
            : 'not published'}
          .{' '}
          {f.versions.firstPatched ? (
            <>
              First patched version <code className={CODE}>{f.versions.firstPatched}</code>.
            </>
          ) : (
            'No patched version is published yet.'
          )}
        </p>
      </div>
      <pre
        aria-label="Dependency path"
        data-source={f.dependency.pathSource}
        className="m-0 overflow-x-auto rounded-md border border-border bg-sidebar px-3 py-2.5 font-mono text-xs leading-[1.8] text-foreground-2"
      >
        {path.map((p, i) => (
          <span key={i} className="block">
            {i > 0 ? `${'  '.repeat(i - 1)}└ ` : ''}
            {i === path.length - 1 ? <b className="font-medium text-foreground">{p}</b> : p}
          </span>
        ))}
      </pre>
      <p className="text-xs text-muted-foreground">{PATH_NOTE[f.dependency.pathSource]}</p>
      {f.versions.installed ? null : (
        <p className="text-xs text-muted-foreground">Version unknown: {unknownVersionReason(f)}</p>
      )}
    </PaneSection>
  )
}

export function HistorySection({ f }: { f: FindingDetail }) {
  return (
    <PaneSection title="History">
      {f.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events recorded yet.</p>
      ) : (
        <ul aria-label="History" className="m-0 flex list-none flex-col p-0">
          {f.history.map((e) => {
            const Icon = eventIcon(e.type)
            return (
              <li
                key={e.id}
                className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-border py-2.5 text-sm first:border-t-0 first:pt-0"
              >
                <Icon
                  aria-hidden="true"
                  className={cn('mt-0.5 size-4 text-muted-foreground', eventTone(e.type))}
                  stroke={1.75}
                />
                <span>
                  {eventSentence(e)}
                  {e.reason ? (
                    <span className="text-foreground-2">: &ldquo;{e.reason}&rdquo;</span>
                  ) : null}
                </span>
                <time
                  dateTime={e.at}
                  title={new Date(e.at).toLocaleString()}
                  className="col-start-2 text-xs text-muted-foreground"
                >
                  {formatDateTime(e.at)}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </PaneSection>
  )
}

const CHANNEL_KIND: Record<string, string> = {
  discord: 'Discord',
  webhook: 'Webhook',
  email: 'Email',
}

export function NotificationsSection({ f }: { f: FindingDetail }) {
  return (
    <PaneSection title="Notifications">
      {f.notifications.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No message was sent about it. Daily digests are not listed here.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {f.notifications.map((n) => (
            <li key={`${n.channelId}-${n.eventId}`} className="flex flex-col gap-0.5">
              <span>
                <b className="font-medium">{n.channelName ?? 'A removed channel'}</b>
                {n.channelKind ? (
                  <span className="text-muted-foreground">
                    {' '}
                    ({CHANNEL_KIND[n.channelKind] ?? n.channelKind})
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {n.event === 'reopened' ? 'Announced it came back' : 'Announced it'},{' '}
                <time dateTime={n.sentAt} title={new Date(n.sentAt).toLocaleString()}>
                  {formatRelative(n.sentAt)}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </PaneSection>
  )
}

export function DetailsList({ f, className }: { f: FindingDetail; className?: string }) {
  const a = f.advisory
  const items: { label: string; value: ReactNode; mono?: boolean; title?: string }[] = []
  if (f.kind === 'advisory') {
    if (a) items.push({ label: 'Ecosystem', value: a.ecosystem })
    const ranges = f.versions.vulnerableRanges.length
      ? f.versions.vulnerableRanges
      : (a?.vulnerableRanges ?? [])
    if (ranges.length) items.push({ label: 'Vulnerable', value: ranges.join('; '), mono: true })
    if (a?.publishedAt) items.push({ label: 'Published', value: formatDate(a.publishedAt) })
    const how = via(f)
    items.push({
      label: 'Dependency',
      value: `${SCOPE_LABEL[f.dependency.scope]}${how ? `, ${how}` : ''}`,
    })
    items.push({
      label: 'Installed',
      value: f.versions.installed ?? 'Unknown',
      // The reason is long, so it shows in full under the dependency path.
      title: f.versions.installed ?? unknownVersionReason(f),
      mono: f.versions.installed !== null,
    })
    items.push({
      label: 'Manifest',
      value: f.dependency.manifestPaths.join(', ') || 'Unknown',
      mono: true,
    })
  }
  if (f.kind === 'guard' && f.guard) {
    items.push({ label: 'Check', value: f.guard.title })
    items.push({ label: 'Level', value: GUARD_LEVEL_LABEL[f.guard.level] })
    if (f.guard.override) {
      items.push({
        label: 'Turned off',
        value: `For the ${f.guard.override.scope}, ${formatDate(f.guard.override.createdAt)}`,
      })
    }
  }
  if (f.repo) {
    items.push({
      label: 'Repo',
      value: (
        <Link
          to="/repos/$id"
          params={{ id: String(f.repo.id) }}
          className="text-foreground hover:underline"
        >
          {f.repo.fullName}
        </Link>
      ),
      mono: true,
      title: f.repo.fullName,
    })
  }
  if (f.releaseTag) items.push({ label: 'Release', value: f.releaseTag, mono: true })
  if (f.kind === 'guard') items.push({ label: 'On', value: guardSubject(f), mono: true })
  else if (f.kind !== 'advisory')
    items.push({ label: 'On', value: blindSpotSubject(f), mono: true })
  items.push({ label: 'Tier', value: TIER_INFO[f.tier].name })
  items.push({ label: 'First seen', value: formatDate(f.firstSeenAt) })
  items.push({ label: 'Last seen', value: formatRelative(f.lastSeenAt) })
  return <KeyValues items={items} className={className} />
}

// ---------------------------------------------------------------------------
// Guards

/** Copy with `backtick` spans, the spans drawn as code. */
export function CodeText({ text }: { text: string }) {
  return codeParts(text).map((part, i) =>
    part.code ? (
      <code key={i} className={CODE}>
        {part.text}
      </code>
    ) : (
      <span key={i}>{part.text}</span>
    ),
  )
}

/** Why a guard finding matters, from the check's copy for its level. */
export function GuardExplanation({ f }: { f: FindingDetail }) {
  if (!f.guard) return null
  return (
    <PaneSection title="Why it matters">
      <p className="max-w-[68ch] text-foreground-2">
        <CodeText text={f.guard.explanation} />
      </p>
    </PaneSection>
  )
}

/** What the check read, per check, so the level can be checked by hand. */
export function GuardEvidenceSection({ f }: { f: FindingDetail }) {
  if (!f.guard) return null
  return (
    <PaneSection title="What Hinomi read" aside={`Last checked ${formatRelative(f.lastSeenAt)}`}>
      <GuardEvidenceView evidence={f.guard.evidence} level={f.guard.level} />
    </PaneSection>
  )
}
