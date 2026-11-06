import type * as React from 'react'

export interface PageHeaderProps {
  title: React.ReactNode
  children?: React.ReactNode
  /** Right-aligned actions or badges. */
  actions?: React.ReactNode
}

export function PageHeader({ title, children, actions }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl leading-tight">{title}</h1>
        {children ? (
          <p className="mt-1.5 max-w-[62ch] text-pretty text-foreground-2">{children}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2 tab:ml-auto">{actions}</div> : null}
    </div>
  )
}
