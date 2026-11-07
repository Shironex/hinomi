import type * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * One settings section in the detail pane: its title with a short note beside it, an optional
 * intro line, then its boxes. The section is a region named by its title.
 */
export function SettingsSection({
  id,
  title,
  note,
  intro,
  children,
}: {
  id: string
  title: string
  note?: React.ReactNode
  intro?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`${id}-title`} tabIndex={-1} className="text-lg outline-none">
            {title}
          </h2>
          {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
        </div>
        {intro ? (
          <p className="max-w-[70ch] text-sm text-pretty text-foreground-2">{intro}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** A smaller heading inside a section ("Delivery"), with an optional note. */
export function SubHeading({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-md">{title}</h3>
      {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
    </div>
  )
}

/** The design's .box: a bordered panel that holds setting rows separated by rules. */
export function SetBox({
  as = 'div',
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, 'ref'> & { as?: 'div' | 'ul' }) {
  const Comp = as
  return (
    <Comp
      className={cn('flex flex-col rounded-lg border border-border bg-card px-5 py-1', className)}
      {...props}
    />
  )
}

/**
 * The design's .setrow: a 36 px icon tile, a title (an h3) with a meta line, and something on
 * the right (a status pill or a switch). `children` go under the title, for actions and forms.
 */
export function SetRow({
  as: Comp = 'div',
  icon,
  title,
  sub,
  aside,
  stackAside = false,
  children,
  className,
}: {
  as?: 'div' | 'li'
  icon: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  aside?: React.ReactNode
  /** On the phone, put the aside under the title instead of beside it (for wide pills). */
  stackAside?: boolean
  children?: React.ReactNode
  className?: string
}) {
  return (
    <Comp
      className={cn(
        'grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 border-t border-border py-3.5 first:border-t-0',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-9 place-items-center rounded-md bg-muted text-foreground-2 [&_svg]:size-[18px]"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <h3 className="truncate text-base font-semibold">{title}</h3>
        {sub ? <span className="text-xs text-pretty text-muted-foreground">{sub}</span> : null}
      </span>
      {stackAside ? (
        <span className="col-start-2 row-start-2 justify-self-start tab:col-start-3 tab:row-start-1 tab:justify-self-end">
          {aside}
        </span>
      ) : (
        (aside ?? <span />)
      )}
      {children ? (
        <div className="col-span-3 flex min-w-0 flex-col gap-3 pt-2 tab:col-span-2 tab:col-start-2">
          {children}
        </div>
      ) : null}
    </Comp>
  )
}

/** The design's .panel with body padding. */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-4 rounded-lg border border-border bg-card p-5', className)}
      {...props}
    />
  )
}

/** Small "Saving" / "Saved" / error line next to controls that save on change. */
export function SaveStatus({
  pending,
  saved,
  error,
}: {
  pending: boolean
  saved: boolean
  error: string | null
}) {
  return (
    <span
      aria-live="polite"
      className={cn('text-xs', error ? 'text-sev-critical' : 'text-muted-foreground')}
    >
      {pending ? 'Saving' : error ? error : saved ? 'Saved' : ''}
    </span>
  )
}

/** Inline code in settings copy. */
export const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-[max(13px,0.92em)] text-foreground">{children}</code>
)
