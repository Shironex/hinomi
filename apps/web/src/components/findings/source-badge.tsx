import type { Reporter } from '@hinomi/shared'
import { Badge } from '@/components/ui/badge'
import { sourcesLabel, sourcesTitle } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'
import { SOURCE_ICON, sourceKey } from '@/lib/view-icons'

/** Which source reported the finding: GitHub, OSV or both. */
export function SourceBadge({
  sources,
  className,
}: {
  sources: readonly Reporter[]
  className?: string
}) {
  const IconCmp = SOURCE_ICON[sourceKey(sources)]
  return (
    <Badge
      variant="outline"
      title={sourcesTitle(sources)}
      className={cn('h-[22px] px-1.5 text-xs text-muted-foreground [&_svg]:size-3.5', className)}
    >
      <IconCmp aria-hidden="true" stroke={1.75} />
      {sourcesLabel(sources)}
    </Badge>
  )
}
