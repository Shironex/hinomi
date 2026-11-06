import { IconBox, IconEyeOff, IconShieldCheck } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { SEVERITY_LABEL, type SeverityKey } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'
import { SEVERITY_ICON, SEVERITY_TONE } from '@/lib/view-icons'

/**
 * Severity is never color alone: each level has its own icon, word and fill weight. Critical is
 * the only solid (red) fill; high, moderate and low are icon and word on no fill.
 */
const TEXT_ONLY = 'border-transparent bg-transparent pl-0.5'
const SEVERITY_BADGE: Record<SeverityKey, string> = {
  critical: '',
  high: cn(TEXT_ONLY, 'text-sev-high'),
  moderate: cn(TEXT_ONLY, 'text-sev-moderate'),
  low: cn(TEXT_ONLY, 'text-sev-low'),
}

export function SeverityBadge({
  severity,
  className,
}: {
  severity: SeverityKey
  className?: string
}) {
  const IconCmp = SEVERITY_ICON[severity]
  return (
    <Badge
      variant={severity === 'critical' ? 'critical-solid' : 'outline'}
      className={cn(SEVERITY_BADGE[severity], className)}
    >
      <IconCmp aria-hidden="true" stroke={2} />
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

export function BlindSpotBadge({
  className,
  label = 'Blind spot',
}: {
  className?: string
  label?: string
}) {
  return (
    <Badge variant="blind" className={className}>
      <IconEyeOff aria-hidden="true" stroke={2} />
      {label}
    </Badge>
  )
}

/** A coverage note: deployed from an image, not a blind spot. Quiet on purpose. */
export function ImageOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      <IconBox aria-hidden="true" stroke={2} />
      Image only
    </Badge>
  )
}

/** GitHub's alert is still open, but the lockfile already resolves only patched versions. */
export function PatchedBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      <IconShieldCheck aria-hidden="true" stroke={2} />
      Patched in lockfile
    </Badge>
  )
}

/** Compact per-severity counts, for table cells: "1 2 9" with icons and colors. */
export function SeverityCounts({
  counts,
  className,
  empty = 'None open',
}: {
  counts: Record<SeverityKey, number>
  className?: string
  empty?: string
}) {
  const parts = (Object.keys(SEVERITY_ICON) as SeverityKey[]).filter((k) => counts[k] > 0)
  if (parts.length === 0) return <span className="text-sm text-muted-foreground">{empty}</span>
  const label = parts.map((k) => `${counts[k]} ${k}`).join(', ')
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      aria-label={label}
      title={label}
    >
      {parts.map((k) => {
        const IconCmp = SEVERITY_ICON[k]
        return (
          <span
            key={k}
            aria-hidden="true"
            className={cn(
              'inline-flex items-center gap-[3px] rounded-[3px] px-[5px] py-px text-xs font-semibold tabular-nums',
              SEVERITY_TONE[k],
            )}
          >
            <IconCmp className="size-3" stroke={2} />
            {counts[k]}
          </span>
        )
      })}
    </span>
  )
}
