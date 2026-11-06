import type * as React from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

/** The design's .input: 34px, 6px radius, strong border, focus ring drawn over the border. */
const inputClass =
  'h-[34px] w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm text-foreground transition-[border-color] placeholder:text-muted-foreground placeholder:opacity-85 focus-visible:border-transparent focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-sev-critical'

function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />
}

/** Native select styled like the inputs, so phones get their own picker. */
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <span className={cn('relative flex min-w-0 items-center', className)}>
      <select
        data-slot="select"
        className={cn(inputClass, 'cursor-pointer appearance-none pr-8')}
        {...props}
      />
      <IconChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground"
        stroke={1.75}
      />
    </span>
  )
}

export { Input, NativeSelect, inputClass }
