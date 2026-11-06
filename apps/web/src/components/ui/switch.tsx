import type * as React from 'react'
import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<React.ComponentProps<'button'>, 'onChange' | 'role'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/** The design's .toggle: a 34 by 20 pill with role="switch". */
function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-5 w-[34px] shrink-0 cursor-pointer rounded-full bg-input transition-colors duration-150 outline-none after:absolute after:top-[3px] after:left-[3px] after:size-3.5 after:rounded-full after:bg-card after:transition-transform after:duration-200 after:ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-primary aria-checked:after:translate-x-3.5',
        className,
      )}
      {...props}
    />
  )
}

export { Switch }
