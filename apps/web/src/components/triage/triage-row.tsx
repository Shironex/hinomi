import type { FindingListItem } from '@hinomi/shared'
import {
  IconClockPause,
  IconEyeOff,
  IconGitPullRequest,
  IconPower,
  IconShieldCheck,
  IconShieldOff,
} from '@tabler/icons-react'
import { StatusText } from '@/components/findings/finding-state'
import { GuardKindChip, GuardLevelBadge } from '@/components/guards/guard-badges'
import {
  BlindSpotBadge,
  ImageOnlyBadge,
  PatchedBadge,
  SeverityBadge,
} from '@/components/findings/severity-badge'
import { decisionLabel, findingTitle, formatAge, gapInfo, isDecided } from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { evidenceSummary } from '@/lib/guard-meta'
import { findingName } from '@/lib/triage'
import { cn } from '@/lib/utils'

/**
 * The finding's badge: severity as icon and word, what kind of gap it is, or a guard's level in
 * the look of the severity it counts as, with the Guard chip beside it.
 */
export function FindingBadge({ item }: { item: FindingListItem }) {
  if (item.kind === 'guard' && item.guard) {
    return (
      <>
        <GuardLevelBadge level={item.guard.level} severity={item.factors.severity} />
        <GuardKindChip />
      </>
    )
  }
  if (item.kind === 'coverage_note') return <ImageOnlyBadge />
  if (item.kind === 'blind_spot') return <BlindSpotBadge />
  if (item.patchedInLockfile) return <PatchedBadge />
  return <SeverityBadge severity={item.factors.severity} />
}

/** Where it runs, in a few words: the first app, the repo, or nothing deployed. */
function where(item: FindingListItem): string {
  const first = item.deployments[0]
  if (first) {
    const more = item.deployments.length - 1
    return more > 0 ? `${first.name} +${more}` : first.name
  }
  return item.repo ? `${item.repo.name}, not deployed` : 'Not deployed'
}

/**
 * The state of a row in a few words. Blind spots keep their cyan, never red; plain open
 * advisories say whether a release can fix them yet.
 */
export function RowState({ item, plain = false }: { item: FindingListItem; plain?: boolean }) {
  const decided = decisionLabel(item)
  const title = item.stateReason ? `${decided ?? ''}: ${item.stateReason}` : undefined
  if (item.guard?.override && item.state === 'accepted') {
    return (
      <StatusText icon={IconPower} title={`Turned off: ${item.guard.override.reason}`}>
        Turned off
      </StatusText>
    )
  }
  switch (item.state) {
    case 'snoozed':
    case 'accepted':
      return (
        <StatusText icon={IconClockPause} title={title}>
          {decided}
        </StatusText>
      )
    case 'dismissed_upstream':
      return (
        <StatusText icon={IconShieldOff} title={title}>
          {decided}
        </StatusText>
      )
    case 'fixing':
      return (
        <StatusText icon={IconGitPullRequest} tone="run">
          Fix in progress
        </StatusText>
      )
    case 'fixed':
      return (
        <StatusText icon={IconShieldCheck} tone="ok">
          {item.kind === 'advisory' ? 'Fixed' : 'Resolved'}
        </StatusText>
      )
    case 'open':
      if (item.kind === 'blind_spot') {
        return (
          <StatusText icon={IconEyeOff} className="text-blind">
            {gapInfo(item)?.short ?? 'Open'}
          </StatusText>
        )
      }
      if (item.kind === 'guard' && item.guard) {
        const text = evidenceSummary(item.guard.evidence, item.guard.level)
        return (
          <span className="truncate text-xs text-muted-foreground" title={text}>
            {text}
          </span>
        )
      }
      if (item.kind === 'coverage_note') {
        return <span className="text-xs text-muted-foreground">{gapInfo(item)?.short}</span>
      }
      if (item.patchedInLockfile) {
        return (
          <StatusText icon={IconShieldCheck} tone="ok">
            GitHub alert still open
          </StatusText>
        )
      }
      if (plain) return <span className="text-xs text-muted-foreground">Open</span>
      return (
        <StatusText tone="wait">
          {item.advisory?.firstPatchedVersion ? 'No fix started' : 'No patch yet'}
        </StatusText>
      )
  }
}

/**
 * One finding in a triage list pane: rank, badge and package, the score or age on the right,
 * the summary on one line, then where it runs and its state. Decided rows stay, drawn quieter.
 */
export function TriageRow({
  item,
  rank,
  right = 'cvss',
}: {
  item: FindingListItem
  rank?: number
  /** The exposure list shows the CVSS score; All alerts shows how old the finding is. */
  right?: 'cvss' | 'age'
}) {
  const decided = isDecided(item.state)
  const cvss = item.advisory?.cvssScore
  return (
    <span
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1',
        rank !== undefined && 'grid-cols-[24px_minmax(0,1fr)_auto]',
      )}
    >
      {rank !== undefined ? (
        <span className="row-span-3 pt-[3px] font-mono text-xs text-muted-foreground tabular-nums">
          {rank}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
        <FindingBadge item={item} />
        <span className="truncate font-mono text-base font-medium text-foreground">
          {findingName(item)}
        </span>
      </span>
      {right === 'cvss' ? (
        <span className="pt-0.5 font-mono text-sm font-semibold text-foreground-2 tabular-nums">
          {cvss != null ? cvss.toFixed(1) : ''}
        </span>
      ) : (
        <time
          dateTime={item.firstSeenAt}
          title={`First seen ${formatRelative(item.firstSeenAt)}`}
          className="pt-0.5 text-xs text-muted-foreground tabular-nums"
        >
          {formatAge(item.firstSeenAt)}
        </time>
      )}
      <span
        className={cn(
          'col-span-2 truncate text-base',
          decided ? 'text-foreground-2' : 'text-foreground',
        )}
      >
        {findingTitle(item)}
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-3 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
        <span className="truncate font-medium text-foreground-2">{where(item)}</span>
        <RowState item={item} plain={right === 'age'} />
      </span>
    </span>
  )
}
