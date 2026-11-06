import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// The design's .badge: 24px, 6px radius. Severity variants always pair with an icon and a word.
const badgeVariants = cva(
  "inline-flex h-6 shrink-0 items-center gap-[5px] rounded-sm border pr-[9px] pl-[7px] text-xs font-semibold whitespace-nowrap [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground-2',
        outline: 'border-border bg-transparent text-foreground-2',
        accent: 'border-transparent bg-accent text-accent-ink',
        success: 'border-transparent bg-success-soft text-success',
        critical: 'border-transparent bg-sev-critical-soft text-sev-critical',
        /** Solid fill: only the critical severity itself, so red keeps one meaning. */
        'critical-solid': 'border-transparent bg-sev-critical text-sev-critical-on',
        /** Blind spots: cyan hatch, never red. */
        blind:
          'border-[color-mix(in_oklab,var(--blind)_55%,transparent)] bg-(image:--blind-hatch) text-blind',
        high: 'border-transparent bg-sev-high-soft text-sev-high',
        moderate: 'border-transparent bg-sev-moderate-soft text-sev-moderate',
        low: 'border-transparent bg-sev-low-soft text-sev-low',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
