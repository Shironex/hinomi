import type { GuardCheck, GuardLevel, GuardResult } from '@hinomi/shared'
import {
  IconActivityHeartbeat,
  IconBrandDocker,
  IconCircleDashed,
  IconEyeOff,
  IconHelpCircle,
  IconNetwork,
  IconShieldCheck,
  IconShieldHalf,
  IconStack2,
  IconUserShield,
  IconGitCompare,
  IconBolt,
  type Icon,
} from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { SEVERITY_LABEL, type SeverityKey } from '@/lib/finding-meta'
import { GUARD_LEVEL_LABEL, GUARD_RESULT_LABEL } from '@/lib/guard-meta'
import { cn } from '@/lib/utils'
import { SEVERITY_BADGE, SEVERITY_ICON } from '@/lib/view-icons'

/** An icon per check, for the checks page, the deployment panel and the overview card. */
export const GUARD_CHECK_ICON: Record<GuardCheck, Icon> = {
  root_user: IconUserShield,
  docker_socket: IconBrandDocker,
  shared_network: IconNetwork,
  watch_paths_skip: IconEyeOff,
  framework_support: IconStack2,
  runtime_support: IconActivityHeartbeat,
  runtime_pins_disagree: IconGitCompare,
  action_runtime: IconBolt,
}

/** When a level has no ranked finding behind it (the deployment panel), it reads like this. */
const LEVEL_SEVERITY: Record<'fail' | 'warn', SeverityKey> = { fail: 'high', warn: 'moderate' }

/**
 * A guard level in the severity look: the icon and ink of the severity it counts as, with the
 * level as the word ("Fail" in high ink for a root container). Unknown is quiet: the source
 * cannot tell, so it ranks like a coverage note.
 */
export function GuardLevelBadge({
  level,
  severity,
  className,
}: {
  level: GuardLevel
  /** The severity the finding ranks as (its factors). Falls back to high for fail, moderate for warn. */
  severity?: SeverityKey
  className?: string
}) {
  if (level === 'unknown') {
    return (
      <Badge
        variant="outline"
        className={className}
        title="Unknown: the source cannot give this signal"
      >
        <IconHelpCircle aria-hidden="true" stroke={2} />
        {GUARD_LEVEL_LABEL.unknown}
      </Badge>
    )
  }
  const sev = severity ?? LEVEL_SEVERITY[level]
  const IconCmp = SEVERITY_ICON[sev]
  return (
    <Badge
      variant={sev === 'critical' ? 'critical-solid' : 'outline'}
      className={cn(SEVERITY_BADGE[sev], className)}
      title={`${GUARD_LEVEL_LABEL[level]}, counts as ${SEVERITY_LABEL[sev].toLowerCase()}`}
    >
      <IconCmp aria-hidden="true" stroke={2} />
      {GUARD_LEVEL_LABEL[level]}
    </Badge>
  )
}

/** A check's result on a subject: a level, pass, or not run yet. */
export function GuardResultBadge({
  result,
  className,
}: {
  result: GuardResult | null
  className?: string
}) {
  if (result === null) {
    return (
      <Badge variant="outline" className={className} title="No scan ran this check here yet">
        <IconCircleDashed aria-hidden="true" stroke={2} />
        Not run
      </Badge>
    )
  }
  if (result === 'pass') {
    return (
      <Badge variant="success" className={className}>
        <IconShieldCheck aria-hidden="true" stroke={2} />
        {GUARD_RESULT_LABEL.pass}
      </Badge>
    )
  }
  return <GuardLevelBadge level={result} className={className} />
}

/** Tells a guard row from an advisory in the same tier (decision Q2). */
export function GuardKindChip({ className }: { className?: string }) {
  return (
    <Badge variant="default" className={cn('h-5 px-1.5 text-[11px]', className)}>
      <IconShieldHalf aria-hidden="true" className="size-3" stroke={2} />
      Guard
    </Badge>
  )
}
