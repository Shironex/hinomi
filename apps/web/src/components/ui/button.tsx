import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from 'radix-ui'

// Matches the design's .btn primitive: 34px default, 10px radius, strong border on neutral buttons.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border font-[550] whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border-input bg-card text-foreground hover:bg-muted aria-expanded:bg-muted',
        secondary: 'border-transparent bg-muted text-foreground hover:bg-accent',
        ghost:
          'border-transparent bg-transparent text-foreground-2 hover:bg-muted hover:text-foreground aria-expanded:bg-muted',
        destructive:
          'border-transparent bg-sev-critical-soft text-sev-critical hover:bg-[color-mix(in_oklch,var(--sev-critical-soft),var(--sev-critical)_12%)]',
        link: 'border-transparent text-accent-ink underline-offset-2 hover:underline',
      },
      size: {
        default: 'h-[34px] gap-[7px] px-[13px] text-sm',
        xs: "h-6 gap-1 rounded-sm px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-[30px] gap-1.5 px-[11px] text-xs [&_svg:not([class*='size-'])]:size-[15px]",
        lg: 'h-[38px] gap-2 px-4 text-base',
        icon: 'size-[34px]',
        'icon-xs': "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': "size-[30px] [&_svg:not([class*='size-'])]:size-[15px]",
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
