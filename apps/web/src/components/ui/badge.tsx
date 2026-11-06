import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// The design's .badge: 22px, 4px radius. Severity variants always pair with an icon and a word.
const badgeVariants = cva(
  "inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-sm border px-[7px] text-xs font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-[13px]",
  {
    variants: {
      variant: {
        default: 'border-border bg-card text-foreground-2',
        outline: 'border-border bg-transparent text-foreground-2',
        accent: 'border-transparent bg-accent text-accent-ink',
        success: 'border-transparent bg-success-soft text-success',
        critical: 'border-transparent bg-sev-critical-soft text-sev-critical',
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
