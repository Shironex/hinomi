import type * as React from 'react'
import { cn } from '@/lib/utils'

/** Shimmering placeholder block. The shimmer stops under prefers-reduced-motion. */
function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        'block max-w-full animate-shimmer rounded-sm bg-[linear-gradient(90deg,var(--muted)_0%,color-mix(in_oklch,var(--muted)_55%,var(--card))_50%,var(--muted)_100%)] bg-size-[200%_100%] motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
