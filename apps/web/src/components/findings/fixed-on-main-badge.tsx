import { IconGitMerge } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { FIXED_ON_MAIN_HINT, FIXED_ON_MAIN_LABEL } from '@/lib/release-meta'

/**
 * A release finding the default branch already fixed: a patched release is due. The words carry
 * the meaning, the green icon only backs them up.
 */
export function FixedOnMainBadge({ className }: { className?: string }) {
  return (
    <Badge variant="success" title={FIXED_ON_MAIN_HINT} className={className}>
      <IconGitMerge aria-hidden="true" stroke={2} />
      {FIXED_ON_MAIN_LABEL}
    </Badge>
  )
}
