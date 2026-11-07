import type { FindingListItem } from '@hinomi/shared'
import {
  IconCircleCheck,
  IconClockPause,
  IconEyeOff,
  IconGitPullRequest,
  IconPower,
  IconShieldCheck,
  IconShieldOff,
  type Icon,
} from '@tabler/icons-react'
import { decisionLabel, gapInfo } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'

export type StatusTone = 'neutral' | 'ok' | 'bad' | 'wait' | 'run'

const TONE: Record<StatusTone, string> = {
  neutral: 'text-foreground-2',
  ok: 'text-success',
  bad: 'text-sev-critical',
  wait: 'text-sev-high',
  run: 'text-accent-ink',
}

/** The design's .state: a small icon and a word in a tone. */
export function StatusText({
  icon: IconCmp,
  tone = 'neutral',
  children,
  className,
  title,
}: {
  icon?: Icon
  tone?: StatusTone
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {IconCmp ? (
        <IconCmp aria-hidden="true" className="size-3.5 shrink-0" stroke={1.75} />
      ) : (
        <span
          aria-hidden="true"
          className="inline-block size-[7px] shrink-0 rounded-full bg-current"
        />
      )}
      {children}
    </span>
  )
}

/** State of a finding as a row shows it; decisions keep their expiry and reason in the title. */
export function FindingStateText({
  item,
  className,
  table = false,
}: {
  item: Pick<
    FindingListItem,
    'state' | 'stateUntil' | 'stateReason' | 'kind' | 'blindSpotType' | 'coverageNote'
  > & { guard?: FindingListItem['guard'] }
  className?: string
  /** Table cells say a plain "Open"; ranked rows say what is missing. */
  table?: boolean
}) {
  const decided = decisionLabel(item)
  const title = item.stateReason ? `${decided ?? ''}: ${item.stateReason}` : undefined
  if (item.guard?.override && item.state === 'accepted') {
    return (
      <StatusText
        icon={IconPower}
        title={`Turned off: ${item.guard.override.reason}`}
        className={className}
      >
        Turned off
      </StatusText>
    )
  }
  switch (item.state) {
    case 'snoozed':
    case 'accepted':
      return (
        <StatusText icon={IconClockPause} title={title} className={className}>
          {decided}
        </StatusText>
      )
    case 'dismissed_upstream':
      return (
        <StatusText icon={IconShieldOff} title={title} className={className}>
          {decided}
        </StatusText>
      )
    case 'fixing':
      return (
        <StatusText icon={IconGitPullRequest} tone="run" className={className}>
          Fix in progress
        </StatusText>
      )
    case 'fixed':
      return (
        <StatusText
          icon={item.kind === 'advisory' ? IconShieldCheck : IconCircleCheck}
          tone="ok"
          className={className}
        >
          {item.kind === 'advisory' ? 'Fixed' : 'Resolved'}
        </StatusText>
      )
    case 'open':
      if (item.kind === 'coverage_note') {
        return (
          <span className={cn('text-xs text-muted-foreground', className)}>
            {gapInfo(item)?.short ?? 'Open'}
          </span>
        )
      }
      if (item.kind === 'blind_spot') {
        return (
          <StatusText icon={IconEyeOff} className={cn('text-blind', className)}>
            {gapInfo(item)?.short ?? 'Open'}
          </StatusText>
        )
      }
      if (table || item.kind === 'guard') {
        return <span className={cn('text-xs text-muted-foreground', className)}>Open</span>
      }
      return (
        <StatusText tone="wait" className={className}>
          No fix started
        </StatusText>
      )
  }
}
