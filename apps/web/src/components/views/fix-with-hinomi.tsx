import type * as React from 'react'
import { IconRobot } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { NO_PLAN_NOTE, requestFix, type FixRequestRepo } from '@/lib/fix-request'

/**
 * Opens the dispatch dialog for the latest plan of one of `repos` (only repos with a plan).
 * Without any, the button stays off and says why on hover and to screen readers through
 * `noteId`, which names an element the caller renders with NO_PLAN_NOTE.
 */
export function FixWithHinomi({
  repos,
  findingId,
  noteId,
  hint = false,
  className,
  size = 'default',
}: {
  repos: readonly FixRequestRepo[]
  findingId?: number
  noteId?: string
  /** Shows the f key on the button (the view handles f for its selected item). */
  hint?: boolean
  className?: string
  size?: React.ComponentProps<typeof Button>['size']
}) {
  const off = repos.length === 0
  return (
    <Button
      size={size}
      className={className}
      disabled={off}
      title={off ? NO_PLAN_NOTE : undefined}
      aria-describedby={off ? noteId : undefined}
      onClick={() => requestFix({ repos, ...(findingId !== undefined && { findingId }) })}
    >
      <IconRobot aria-hidden="true" />
      Fix with Hinomi
      {hint && !off ? (
        <Kbd
          aria-hidden="true"
          className="ml-0.5 border-transparent bg-[color-mix(in_oklab,var(--primary-foreground)_18%,transparent)] text-primary-foreground"
        >
          f
        </Kbd>
      ) : null}
    </Button>
  )
}
