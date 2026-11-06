import type * as React from 'react'
import type { Icon } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

/** The design's .panel: a 10px card with an optional header row. */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border border-border bg-card', className)} {...props} />
}

export function PanelHeader({
  title,
  icon: IconCmp,
  children,
  className,
  level = 2,
}: {
  title: React.ReactNode
  icon?: Icon
  /** Right side, pushed to the end. */
  children?: React.ReactNode
  className?: string
  level?: 2 | 3
}) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('flex items-center gap-2.5 border-b border-border px-4 py-3', className)}>
      {IconCmp ? (
        <IconCmp aria-hidden="true" className="size-4 shrink-0 text-foreground-2" stroke={1.75} />
      ) : null}
      <Heading className="text-base">{title}</Heading>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  )
}

export function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />
}

/** A titled block in the main column. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
  titleId,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  id?: string
  titleId?: string
}) {
  return (
    <section id={id} aria-labelledby={titleId} className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id={titleId} className="text-md">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Label and value pairs, labels left, values right and truncated. */
export function KeyValues({
  items,
  className,
}: {
  items: readonly { label: string; value: React.ReactNode; mono?: boolean; title?: string }[]
  className?: string
}) {
  return (
    <dl
      className={cn('m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 text-sm', className)}
    >
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd
            title={item.title ?? (typeof item.value === 'string' ? item.value : undefined)}
            className={cn(
              'm-0 min-w-0 truncate text-right',
              item.mono && 'font-mono text-[12.5px]',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A timeline of short events with an icon and a time. */
export function Feed({
  items,
  className,
  label,
}: {
  items: readonly {
    key: string | number
    icon: Icon
    body: React.ReactNode
    time: React.ReactNode
    tone?: string
  }[]
  className?: string
  label?: string
}) {
  return (
    <ul aria-label={label} className={cn('m-0 flex list-none flex-col p-0', className)}>
      {items.map((item) => (
        <li
          key={item.key}
          className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 border-t border-border py-2 text-sm first:border-t-0 first:pt-0 last:pb-0"
        >
          <item.icon
            aria-hidden="true"
            className={cn('mt-0.5 size-3.5 text-foreground-2', item.tone)}
            stroke={1.75}
          />
          <div className="min-w-0">
            {item.body}
            <span className="block text-xs text-muted-foreground">{item.time}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A term with a definition on hover and focus, like "exposed" or "blind spot". */
export function Term({ children, definition }: { children: React.ReactNode; definition: string }) {
  return (
    <abbr
      tabIndex={0}
      title={definition}
      className="cursor-help border-b border-dotted border-current no-underline"
    >
      {children}
    </abbr>
  )
}
