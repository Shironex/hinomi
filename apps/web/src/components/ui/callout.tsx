import type * as React from 'react'
import type { Icon } from '@tabler/icons-react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const calloutVariants = cva(
  'flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-sidebar [&>svg]:text-foreground-2',
        info: 'border-[color-mix(in_oklch,var(--primary)_22%,transparent)] bg-accent [&>svg]:text-accent-ink',
        warn: 'border-[color-mix(in_oklch,var(--sev-high)_25%,transparent)] bg-sev-high-soft [&>svg]:text-sev-high',
        danger:
          'border-[color-mix(in_oklch,var(--sev-critical)_40%,transparent)] bg-sev-critical-soft [&>svg]:text-sev-critical',
        ok: 'border-[color-mix(in_oklch,var(--success)_25%,transparent)] bg-success-soft [&>svg]:text-success',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

interface CalloutProps
  extends Omit<React.ComponentProps<'div'>, 'title'>, VariantProps<typeof calloutVariants> {
  icon: Icon
  title: React.ReactNode
}

function Callout({ icon: IconCmp, title, variant, className, children, ...props }: CalloutProps) {
  return (
    <div data-slot="callout" className={cn(calloutVariants({ variant }), className)} {...props}>
      <IconCmp aria-hidden="true" stroke={1.75} />
      <div className="flex min-w-0 flex-col gap-1">
        <b className="font-semibold">{title}</b>
        {children ? <div className="text-foreground-2">{children}</div> : null}
      </div>
    </div>
  )
}

export { Callout }
