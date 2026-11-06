import type * as React from 'react'
import { cn } from '@/lib/utils'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex min-w-[1.5em] items-center justify-center rounded-sm border border-b-2 border-input bg-card px-[5px] py-[3px] font-mono text-[10.5px] leading-none font-normal text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
