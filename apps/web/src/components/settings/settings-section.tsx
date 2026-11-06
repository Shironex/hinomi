import type * as React from 'react'
import { cn } from '@/lib/utils'

/** A titled band of the settings page from the design's .set-sec: intro left, controls right. */
export function SettingsSection({
  id,
  title,
  intro,
  children,
}: {
  id: string
  title: string
  intro: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid scroll-mt-20 gap-3.5 border-t border-border py-6 first:border-t-0 first:pt-0 desk:grid-cols-[minmax(0,240px)_minmax(0,1fr)] desk:gap-6"
    >
      <div>
        <h2 id={`${id}-title`} tabIndex={-1} className="text-md outline-none">
          {title}
        </h2>
        <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{intro}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  )
}

/** The design's .panel with body padding. */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-3.5 rounded-lg border border-border bg-card p-4', className)}
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
