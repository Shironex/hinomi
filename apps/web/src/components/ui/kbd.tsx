import type * as React from 'react'
import { cn } from '@/lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex min-w-[1.6em] items-center justify-center rounded-[4px] border border-input px-1.5 font-mono text-xs leading-[18px] font-normal text-foreground-2',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
